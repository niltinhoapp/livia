// Orquestração do processamento de um evento de Webhook Asaas (OT-06C;
// atomicidade dedup+transição corrigida em OT-06G; terminal vs. transitório
// refinado em OT-06G.1/G.2).
// Só esta camada faz I/O (via dependências injetadas, mesmo padrão de
// ProvisioningDependencies/ConflictRecoveryDependencies) — a tradução em si
// (asaasWebhookEvents.ts) e a máquina de estados (stateMachine.ts)
// permanecem puras e intocadas.
//
// Isolamento estrito (contrato OT-06B, itens 13-15):
//   - Nunca lê nem escreve billingProvisioning/* — só establishments/{id}.billing.
//   - Nunca conecta canUseService() a rota nenhuma.
//   - Nunca toca panelAccess, whatsapp, whatsappBeta, status.
//
// ATOMICIDADE (OT-06G): a versão original (OT-06C) chamava reserveEventId
// como primeiro passo incondicional, ANTES de ler/escrever billing. Uma
// falha depois disso (ex.: Firestore instável durante a leitura de
// establishment) deixava o marker de dedup persistido sem a transição
// correspondente — um retry legítimo da Asaas encontrava "duplicate" e
// nunca reaplicava, perdendo o sinal financeiro em silêncio.
//
// TERMINAL vs. TRANSITÓRIO (OT-06G.1/G.2): nem toda decisão que passa pela
// leitura de billing é definitiva. Três níveis, conforme o que está em jogo:
//
//   1. Eventos que NUNCA tocam establishment/billing (ignored,
//      unresolved_identity): a única escrita é o próprio marker — uma
//      escrita isolada já é atômica por definição, nada para coordenar.
//      reserveEventId (.create(), mesmo padrão de alreadyProcessed em
//      repo.ts) é suficiente e seguro para esses dois casos.
//
//   2. Outcomes TRANSITÓRIOS (establishment_not_found,
//      billing_not_initialized): a causa mais provável (corrida entre
//      criação do establishment e chegada do webhook; billing ainda não
//      inicializado por nenhum fluxo de onboarding — OT-06A) pode se
//      resolver depois. NENHUM marker definitivo é criado — o mesmo
//      event.id continua reprocessável. A rota (route.ts) devolve 503
//      para esses dois outcomes, para que o retry nativo da Asaas continue
//      tentando dentro da janela dela.
//
//   3. Outcomes TERMINAIS (out_of_order, invalid_transition, applied): a
//      decisão é definitiva — out_of_order por garantia matemática
//      (lastAsaasEventAt só cresce), invalid_transition por decisão de
//      negócio já documentada em stateMachine.ts (cancelamento não é
//      revertido automaticamente por webhook de pagamento), applied por
//      já ter sido persistido de fato. Todos os três criam marker
//      definitivo, na MESMA transação da leitura/decisão que levou a eles
//      — nunca existe marker órfão sem a decisão que ele representa. A
//      rota devolve 200 para os três.
//
// Concorrência (duas entregas simultâneas do mesmo event.id) é resolvida
// pelo isolamento de transação do Firestore: a segunda transação a tentar
// commitar volta a ler o marker (já criado pela primeira, quando aplicável)
// e retorna "duplicate" sem reaplicar nada.
import type { BillingStatus, EstablishmentBilling } from "@/types";
import { nextBillingStatus, type BillingEventType } from "./stateMachine";
import {
  parseAsaasWebhookEnvelope,
  parseAsaasEventTimestamp,
  translateAsaasEvent,
  resolveEstablishmentFromExternalReference,
  extractExternalReference,
  extractNextDueDate,
  extractCheckoutSession,
  extractSubscriptionId,
} from "./asaasWebhookEvents";

export interface ResolveAndApplyParams {
  eventId: string;
  establishmentId: string;
  generation: number;
  event: string;
  domainEvent: BillingEventType;
  eventTimestamp: number | null;
  nextDueDate?: string;
  // id da subscription Asaas dona deste evento, quando o payload a informa
  // (ver extractSubscriptionId) — persistido em billing.externalSubscriptionId
  // na mesma transação da transição, necessário para o caminho Hosted
  // Checkout (nunca cria a subscription diretamente, só fica sabendo o id
  // dela pelo próprio webhook).
  subscriptionId?: string;
}

export interface AsaasWebhookProcessingDependencies {
  // Dedup simples (.create() atômico) — só para os dois outcomes que nunca
  // leem/escrevem establishment/billing (ignored, unresolved_identity).
  reserveEventId: (eventId: string) => Promise<boolean>;
  // Dedup + leitura + decisão + escrita (quando aplicável) numa única
  // transação Firestore — para todo outcome que depende do estado de
  // billing. Retorna sempre um AsaasWebhookProcessingResult, mas nunca
  // "invalid_envelope" | "ignored" | "unresolved_identity" (esses são
  // decididos antes de chegar aqui, sem precisar de transação).
  resolveAndApplyEvent: (params: ResolveAndApplyParams) => Promise<AsaasWebhookProcessingResult>;
  // Fallback de identidade para o caminho Hosted Checkout (OT de migração):
  // consultado SÓ quando resolveEstablishmentFromExternalReference não
  // resolveu E o payload carrega um checkoutSession. Lê o vínculo
  // checkoutId -> (establishmentId, generation) persistido por
  // provisionBillingCheckout ANTES do redirecionamento — nunca infere nem
  // faz lookup na Asaas. Ausência do vínculo (checkoutSession desconhecido
  // ou nunca persistido pela Lívia) => null, fail-closed, igual ao
  // contrato de resolveEstablishmentFromExternalReference.
  resolveEstablishmentFromCheckoutSession: (
    checkoutSession: string,
  ) => Promise<{ establishmentId: string; generation: number } | null>;
  now: () => number;
}

export type AsaasWebhookProcessingResult =
  | { outcome: "invalid_envelope" }
  | { outcome: "duplicate"; eventId: string }
  | { outcome: "unresolved_identity"; event: string }
  | { outcome: "establishment_not_found"; event: string; establishmentId: string; generation: number }
  // est.billing nunca foi inicializado (nenhuma rota de onboarding faz isso
  // ainda — OT-06A). Fail-closed: nunca inventa um billingStatus inicial.
  | { outcome: "billing_not_initialized"; event: string; establishmentId: string; generation: number }
  // Cobre tanto eventos totalmente desconhecidos quanto
  // SUBSCRIPTION_INACTIVATED (reconhecido, sem transição por decisão — ver
  // asaasWebhookEvents.ts).
  | { outcome: "ignored"; event: string }
  | { outcome: "out_of_order"; event: string; establishmentId: string; generation: number }
  | { outcome: "invalid_transition"; event: string; establishmentId: string; generation: number; from: BillingStatus }
  | { outcome: "applied"; event: string; establishmentId: string; generation: number; from: BillingStatus; to: BillingStatus };

export async function processAsaasWebhookEvent(
  rawBody: unknown,
  deps: AsaasWebhookProcessingDependencies,
): Promise<AsaasWebhookProcessingResult> {
  const envelope = parseAsaasWebhookEnvelope(rawBody);
  if (!envelope) return { outcome: "invalid_envelope" };

  const domainEvent = translateAsaasEvent(envelope.event);

  if (!domainEvent) {
    // Nunca toca establishment/billing — a única escrita é o marker em si,
    // já atômico sozinho.
    const isNew = await deps.reserveEventId(envelope.id);
    if (!isNew) return { outcome: "duplicate", eventId: envelope.id };
    return { outcome: "ignored", event: envelope.event };
  }

  // Resolução de identidade: externalReference continua a autoridade
  // PRIMÁRIA (contrato original, fluxo PIX direto) — nunca lookup adicional
  // na Asaas, nunca adivinha por customer/subscription (contrato OT-06B
  // item 9). Fallback (OT de migração pro Hosted Checkout): SÓ quando
  // externalReference não resolveu E o payload carrega um checkoutSession,
  // consulta o vínculo persistido por provisionBillingCheckout. Nunca o
  // inverso — um checkoutSession nunca é tentado antes de externalReference
  // falhar, e um checkoutSession sem vínculo persistido pela Lívia nunca
  // resolve identidade nenhuma (fail-closed, mesma garantia de
  // resolveEstablishmentFromExternalReference).
  const checkoutSession = extractCheckoutSession(envelope.data);
  const identity =
    resolveEstablishmentFromExternalReference(extractExternalReference(envelope.data)) ??
    (checkoutSession ? await deps.resolveEstablishmentFromCheckoutSession(checkoutSession) : null);
  if (!identity) {
    // Idem: nada de establishment/billing em jogo, dedup simples basta.
    const isNew = await deps.reserveEventId(envelope.id);
    if (!isNew) return { outcome: "duplicate", eventId: envelope.id };
    return { outcome: "unresolved_identity", event: envelope.event };
  }

  const eventTimestamp = parseAsaasEventTimestamp(envelope.dateCreatedRaw);
  const subscriptionId = extractSubscriptionId(envelope.data);

  // A partir daqui, tudo que envolve ler/decidir/escrever sobre billing
  // acontece atomicamente — ver comentário no topo do arquivo.
  return deps.resolveAndApplyEvent({
    eventId: envelope.id,
    establishmentId: identity.establishmentId,
    generation: identity.generation,
    event: envelope.event,
    domainEvent,
    eventTimestamp,
    nextDueDate: extractNextDueDate(envelope.data),
    ...(subscriptionId !== null ? { subscriptionId } : {}),
  });
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.code === 6 || e.code === "already-exists") return true;
  return typeof e.message === "string" && e.message.includes("ALREADY_EXISTS");
}

// Fábrica das dependências reais — só chamada pela rota, depois de
// autenticação e parsing já terem passado (mesmo padrão de
// createSandboxHarnessDependencies). Import do Firestore adiado para não
// pagar custo de inicialização em nenhum outro caminho.
export async function createAsaasWebhookProcessingDependencies(): Promise<AsaasWebhookProcessingDependencies> {
  const { db } = await import("@/lib/firebase/admin");
  const { resolveCheckoutCorrelation } = await import("./checkoutProvisioning");
  return {
    resolveEstablishmentFromCheckoutSession: async (checkoutSession) => {
      const correlation = await resolveCheckoutCorrelation(checkoutSession);
      return correlation
        ? { establishmentId: correlation.establishmentId, generation: correlation.subscriptionGeneration }
        : null;
    },
    reserveEventId: async (eventId) => {
      const ref = db.collection("_processed_asaas_events").doc(eventId);
      try {
        await ref.create({ at: Date.now() });
        return true;
      } catch (err) {
        if (isAlreadyExists(err)) return false;
        throw err;
      }
    },
    resolveAndApplyEvent: async (params) => {
      return db.runTransaction(async (tx) => {
        const dedupRef = db.collection("_processed_asaas_events").doc(params.eventId);
        const estRef = db.collection("establishments").doc(params.establishmentId);

        // Firestore exige todas as leituras de uma transação antes de
        // qualquer escrita — por isso os dois gets acontecem juntos, antes
        // de qualquer tx.create/tx.update abaixo.
        const [dedupSnap, estSnap] = await Promise.all([tx.get(dedupRef), tx.get(estRef)]);

        if (dedupSnap.exists) {
          return { outcome: "duplicate", eventId: params.eventId };
        }

        const now = Date.now();

        // establishment_not_found e billing_not_initialized são
        // deliberadamente TRANSITÓRIOS (OT-06G.1/G.2): nenhum marker
        // definitivo é criado aqui. A causa mais provável (corrida entre a
        // criação do establishment e a chegada do webhook; billing ainda
        // não inicializado por nenhum fluxo de onboarding — OT-06A) pode
        // se resolver depois, e o mesmo event.id precisa continuar
        // reprocessável quando isso acontecer. Diferente de
        // out_of_order/invalid_transition (abaixo), aqui não temos
        // informação suficiente para decidir com segurança — não é uma
        // conclusão definitiva, é "ainda não posso decidir".
        if (!estSnap.exists) {
          return {
            outcome: "establishment_not_found",
            event: params.event,
            establishmentId: params.establishmentId,
            generation: params.generation,
          };
        }

        const data = estSnap.data() as { billing?: EstablishmentBilling } | undefined;
        const billing = data?.billing ?? null;

        if (!billing) {
          return {
            outcome: "billing_not_initialized",
            event: params.event,
            establishmentId: params.establishmentId,
            generation: params.generation,
          };
        }

        // out_of_order É terminal, de propósito (OT-06G.1): lastAsaasEventAt
        // só cresce, então um evento mais antigo que ele permanece mais
        // antigo para sempre — retry nunca muda essa conclusão. Marker
        // definitivo continua correto aqui.
        if (
          params.eventTimestamp !== null &&
          typeof billing.lastAsaasEventAt === "number" &&
          params.eventTimestamp <= billing.lastAsaasEventAt
        ) {
          tx.create(dedupRef, { at: now, outcome: "out_of_order" });
          return {
            outcome: "out_of_order",
            event: params.event,
            establishmentId: params.establishmentId,
            generation: params.generation,
          };
        }

        // invalid_transition também É terminal, de propósito (OT-06G.1):
        // os únicos casos reais possíveis dado o tradutor atual (payment_*
        // sobre canceled/suspended) refletem uma decisão de negócio já
        // documentada em stateMachine.ts — cancelamento não deve ser
        // revertido automaticamente por um webhook de pagamento. Marker
        // definitivo continua correto aqui.
        //
        // ÚNICA exceção, deliberada (OT de recontratação): payment_confirmed
        // é reescrito para "reactivate" antes de entrar na state machine —
        // stateMachine.ts continua sem saber o que é "geração" (não é
        // alterado; o guard "canceled nunca reativa por payment_confirmed"
        // nele permanece intacto para o caso normal: replay/atraso de
        // webhook da geração já cancelada). O que muda aqui é só a tradução
        // do evento de entrada, e SÓ quando as duas condições provam
        // reprovisionamento genuíno:
        //   1. params.generation >= 2 — geração 1 nunca é escrita
        //      explicitamente (só existe via "?? 1"), então nunca pode, por
        //      si só, provar recontratação deliberada;
        //   2. params.generation === billing.subscriptionGeneration — a
        //      geração do evento é EXATAMENTE a que subscribe/route.ts
        //      gravou ao criar a nova subscription (síncrono, antes do
        //      pagamento). Um replay de uma geração ANTIGA (já superada por
        //      um cancelamento+recontratação posterior) nunca bate aqui,
        //      porque subscriptionGeneration já avançou.
        const isGenuineRecontracting =
          params.domainEvent === "payment_confirmed" &&
          billing.billingStatus === "canceled" &&
          params.generation >= 2 &&
          params.generation === (billing.subscriptionGeneration ?? 1);
        const effectiveDomainEvent = isGenuineRecontracting ? "reactivate" : params.domainEvent;
        const transition = nextBillingStatus(billing.billingStatus, { type: effectiveDomainEvent });
        if (!transition.ok) {
          tx.create(dedupRef, { at: now, outcome: "invalid_transition" });
          return {
            outcome: "invalid_transition",
            event: params.event,
            establishmentId: params.establishmentId,
            generation: params.generation,
            from: billing.billingStatus,
          };
        }

        tx.update(estRef, {
          "billing.billingStatus": transition.next,
          "billing.lastAsaasEventAt": params.eventTimestamp ?? now,
          "billing.updatedAt": now,
          ...(params.nextDueDate !== undefined ? { "billing.nextDueDate": params.nextDueDate } : {}),
          // Necessário para o caminho Hosted Checkout (nunca cria a
          // subscription diretamente — só sabe o id dela por este evento) e
          // idempotente para o caminho PIX (já escrito síncrono em
          // subscribe/route.ts com o MESMO valor; reescrever aqui não muda
          // nada). params.generation já passou pelos guards de
          // out_of_order/invalid_transition acima — nunca chega aqui um
          // evento stale ou de geração superada.
          ...(params.subscriptionId !== undefined ? { "billing.externalSubscriptionId": params.subscriptionId } : {}),
          "billing.subscriptionGeneration": params.generation,
        });
        // Marker definitivo só é criado JUNTO com a escrita da transição,
        // na mesma transação — nunca antes, nunca separado.
        tx.create(dedupRef, { at: now, outcome: "applied" });

        return {
          outcome: "applied",
          event: params.event,
          establishmentId: params.establishmentId,
          generation: params.generation,
          from: billing.billingStatus,
          to: transition.next,
        };
      });
    },
    now: Date.now,
  };
}
