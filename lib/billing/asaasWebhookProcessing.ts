// Orquestração do processamento de um evento de Webhook Asaas (OT-06C;
// atomicidade dedup+transição corrigida em OT-06G).
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
// nunca reaplicava, perdendo o sinal financeiro em silêncio. Corrigido
// dividindo o dedup em duas estratégias, conforme o que está em jogo:
//
//   - Eventos que NUNCA tocam establishment/billing (ignored,
//     unresolved_identity): a única escrita é o próprio marker — uma
//     escrita isolada já é atômica por definição, nada para coordenar.
//     reserveEventId (.create(), mesmo padrão de alreadyProcessed em
//     repo.ts) continua suficiente e seguro para esses dois casos.
//
//   - Qualquer evento que precisa ler o estado de billing para decidir
//     (establishment_not_found, billing_not_initialized, out_of_order,
//     invalid_transition, applied): dedup + leitura + decisão + escrita
//     (quando aplicável) acontecem em UMA ÚNICA transação Firestore
//     (resolveAndApplyEvent). Ou tudo commita junto, ou nada persiste —
//     nunca existe marker órfão sem a transição que ele deveria
//     representar. Concorrência (duas entregas simultâneas do mesmo
//     event.id) é resolvida pelo próprio isolamento de transação do
//     Firestore: a segunda transação a tentar commitar volta a ler o
//     marker (já criado pela primeira) e retorna "duplicate" sem
//     reaplicar nada.
import type { BillingStatus, EstablishmentBilling } from "@/types";
import { nextBillingStatus, type BillingEventType } from "./stateMachine";
import {
  parseAsaasWebhookEnvelope,
  parseAsaasEventTimestamp,
  translateAsaasEvent,
  resolveEstablishmentFromExternalReference,
  extractExternalReference,
  extractNextDueDate,
} from "./asaasWebhookEvents";

export interface ResolveAndApplyParams {
  eventId: string;
  establishmentId: string;
  generation: number;
  event: string;
  domainEvent: BillingEventType;
  eventTimestamp: number | null;
  nextDueDate?: string;
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

  // Resolução de identidade só acontece para eventos que realmente
  // produzem transição — nunca lookup adicional na Asaas, nunca adivinha
  // por customer/subscription (contrato OT-06B item 9).
  const identity = resolveEstablishmentFromExternalReference(extractExternalReference(envelope.data));
  if (!identity) {
    // Idem: nada de establishment/billing em jogo, dedup simples basta.
    const isNew = await deps.reserveEventId(envelope.id);
    if (!isNew) return { outcome: "duplicate", eventId: envelope.id };
    return { outcome: "unresolved_identity", event: envelope.event };
  }

  const eventTimestamp = parseAsaasEventTimestamp(envelope.dateCreatedRaw);

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
  return {
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

        if (!estSnap.exists) {
          tx.create(dedupRef, { at: now, outcome: "establishment_not_found" });
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
          tx.create(dedupRef, { at: now, outcome: "billing_not_initialized" });
          return {
            outcome: "billing_not_initialized",
            event: params.event,
            establishmentId: params.establishmentId,
            generation: params.generation,
          };
        }

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

        const transition = nextBillingStatus(billing.billingStatus, { type: params.domainEvent });
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
