// Repositório: leitura/escrita das coleções do Firestore.
import { randomUUID } from "node:crypto";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { establishmentRef, sub, db } from "@/lib/firebase/admin";
import { normalizePhone } from "@/lib/whatsapp/client";
import { isMarketingOptInSource, normalizeMarketingImportPhone, marketingEligibilityOf } from "@/lib/campaigns";
import { templateParameterBindingsAreValid } from "@/lib/campaignTemplates";
import { generateRandomPin, encryptPin, decryptPin } from "@/lib/whatsapp/tokenCrypto";
import { nextBillingStatus, type BillingEventType } from "@/lib/billing/stateMachine";
import type { WhatsappConnectionMode } from "@/lib/whatsapp/coexistence";
import type {
  Establishment,
  EstablishmentType,
  EstablishmentWhatsapp,
  EncryptedToken,
  BotConfig,
  EstablishmentBilling,
  KnowledgeBase,
  Conversation,
  Message,
  MessageRole,
  CustomerProfile,
  Campaign,
  CampaignTemplateSnapshot,
  CampaignAudienceSnapshot,
  MarketingImportContact,
  MarketingImportDeclaration,
  MarketingImportResult,
  ConversationTask,
  IntentType,
  PendingTask,
  PendingTaskType,
  KnowledgeCorrection,
  CorrectionCategory,
  CampaignRecipient,
  CampaignRecipientStatus,
} from "@/types";

const TRIAL_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Billing inicial de todo NOVO establishment (OT-07C). trialStartAt e
// trialEndsAt derivam do mesmo instante `now` — nunca recalculado depois
// (ver comentário em EstablishmentBilling.trialEndsAt). Só usado na CRIAÇÃO;
// updates nunca chamam isto de novo.
export function initialTrialBilling(now: number): EstablishmentBilling {
  return {
    billingStatus: "trial",
    trialStartAt: now,
    trialEndsAt: now + TRIAL_DAYS_MS,
    updatedAt: now,
  };
}

export function defaultBotConfig(): BotConfig {
  return {
    personaName: "Livia",
    tone: "acolhedora e objetiva",
    bookingEnabled: false,
    ordersEnabled: false,
    voiceRepliesEnabled: false,
    handoffKeywords: ["falar com atendente", "atendente", "humano"],
    medicalGuardrail: false,
  };
}

export async function getEstablishment(id: string): Promise<Establishment | null> {
  const doc = await establishmentRef(id).get();
  return doc.exists ? (doc.data() as Establishment) : null;
}

// Persiste APENAS o vínculo Asaas em establishments/{id}.billing (OT-07E0),
// sem tocar billingStatus/trialStartAt/trialEndsAt nem qualquer outro campo
// de billing. Usa update por dot-path (mesma técnica do webhook em
// asaasWebhookProcessing.ts) — o Firestore mescla campo a campo dentro do
// mapa `billing`, então trial/status existentes são preservados; para um
// establishment legado sem `billing`, o mapa nasce só com o vínculo (não
// inventa trial — migração de legado é deliberadamente fora de escopo).
// Não persiste CPF/CNPJ: esse dado fica só no Asaas (o vínculo local
// necessário é o externalCustomerId). Lança se o establishment não existir
// (o chamador autenticado sempre opera sobre o próprio tenant já criado).
export async function linkEstablishmentBilling(
  id: string,
  link: { externalCustomerId?: string; externalSubscriptionId?: string; subscriptionGeneration?: number },
): Promise<void> {
  const patch: Record<string, unknown> = { "billing.updatedAt": Date.now() };
  if (link.externalCustomerId !== undefined) {
    patch["billing.externalCustomerId"] = link.externalCustomerId;
  }
  if (link.externalSubscriptionId !== undefined) {
    patch["billing.externalSubscriptionId"] = link.externalSubscriptionId;
  }
  if (link.subscriptionGeneration !== undefined) {
    patch["billing.subscriptionGeneration"] = link.subscriptionGeneration;
  }
  await establishmentRef(id).update(patch);
}

export type ApplyBillingStatusExpiryResult = "applied" | "no_change";

/**
 * Dispara grace_expired/trial_expired (lib/billing/stateMachine.ts) contra o
 * billing ATUAL do establishment, dentro de uma transação. Idempotente: se a
 * transição não for mais válida (ex.: já suspenso, ou o billingStatus mudou
 * entre a query do cron e esta chamada — pagamento confirmado no meio do
 * caminho), é um no-op seguro, nunca força um estado. `suspendedAt` só é
 * escrito aqui, exatamente no instante da transição para "suspended" —
 * nenhum outro caminho do código grava este campo (nem o webhook do Asaas,
 * que nunca produz essa transição sozinho).
 */
export async function applyBillingStatusExpiry(
  establishmentId: string,
  event: Extract<BillingEventType, "grace_expired" | "trial_expired">,
  now = Date.now(),
): Promise<ApplyBillingStatusExpiryResult> {
  const ref = establishmentRef(establishmentId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "no_change";
    const est = snap.data() as Establishment;
    if (!est.billing) return "no_change";

    const result = nextBillingStatus(est.billing.billingStatus, { type: event });
    if (!result.ok) return "no_change";

    const patch: Record<string, unknown> = {
      "billing.billingStatus": result.next,
      "billing.updatedAt": now,
    };
    if (result.next === "suspended") patch["billing.suspendedAt"] = now;
    tx.update(ref, patch);
    return "applied";
  });
}

// Cria (se novo) ou atualiza nome/tipo/config do bot do estabelecimento.
export async function upsertEstablishmentConfig(
  id: string,
  data: { name?: string; type?: EstablishmentType; bot?: BotConfig; dailyOwnerSummary?: Establishment["dailyOwnerSummary"] },
): Promise<Establishment> {
  const existing = await getEstablishment(id);
  const now = Date.now();
  const merged: Establishment = existing
    ? {
        ...existing,
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.bot !== undefined ? { bot: data.bot } : {}),
        ...(data.dailyOwnerSummary !== undefined ? { dailyOwnerSummary: data.dailyOwnerSummary } : {}),
      }
    : {
        id,
        name: data.name ?? "",
        type: data.type ?? "outro",
        ownerUid: id, // establishmentId = uid do dono autenticado (1 estabelecimento por conta)
        status: "active",
        createdAt: now,
        billing: initialTrialBilling(now),
        bot: data.bot ?? defaultBotConfig(),
        ...(data.dailyOwnerSummary !== undefined ? { dailyOwnerSummary: data.dailyOwnerSummary } : {}),
      };
  await establishmentRef(id).set(merged, { merge: true });
  return merged;
}

// TTL da lease exclusiva de uma tentativa de conexão de WhatsApp. A lease só
// é assumida dentro do POST /api/whatsapp/connect — ou seja, DEPOIS que o
// estabelecimento já concluiu o popup do Embedded Signup e o frontend já
// enviou code/wabaId/phoneNumberId. O TTL não cobre o tempo de interação no
// popup (isso já passou); cobre o processamento no backend (exchange,
// verificação de posse, subscribe, register, finalize) e o cenário de uma
// requisição travada/lenta ou um processo que caiu no meio do caminho — 8
// minutos dá folga bem acima do tempo normal dessas chamadas (segundos) sem
// deixar uma tentativa travada bloqueando reconexão por muito tempo.
// Centralizado aqui — se precisar ajustar, é o único lugar.
export const WHATSAPP_CONNECT_LEASE_TTL_MS = 8 * 60 * 1000;

export const WHATSAPP_BETA_LIMIT = 10;
const WHATSAPP_BETA_COHORT_ID = "whatsapp-validation-v1";

interface WhatsappBetaCohort {
  limit: number;
  claimed: number;
  activatedAt: number;
  updatedAt: number;
}

function whatsappBetaCohortRef() {
  return db.collection("_system").doc(WHATSAPP_BETA_COHORT_ID);
}

export type WhatsappBetaEligibility =
  | "available"
  | "already_participant"
  | "grandfathered"
  | "cohort_full";

function betaEligibilityOf(tenant: Establishment | null): Exclude<WhatsappBetaEligibility, "cohort_full"> {
  if (tenant?.whatsappBeta?.access === "participant") return "already_participant";
  if (tenant?.whatsappBeta?.access === "grandfathered") return "grandfathered";
  return "available";
}

function hadSuccessfulWhatsappConnection(tenant: Establishment): boolean {
  const whatsapp = tenant.whatsapp;
  if (whatsapp?.status === "connected") return true;
  if (whatsapp?.status !== "disconnected") return false;
  // Uma lease abandonada também pode terminar como "disconnected". Para
  // não grandfather uma tentativa que nunca conectou, exigimos um campo que
  // só é gravado no finalize bem-sucedido e preservado pelo disconnect.
  return whatsapp.connectionMode !== undefined || typeof whatsapp.registeredAt === "number";
}

// Pré-checagem para evitar iniciar OAuth/Meta quando a rodada já está cheia.
// É apenas uma otimização: a decisão autoritativa acontece novamente, de
// forma transacional, junto da finalização da conexão.
export async function getWhatsappBetaEligibility(id: string): Promise<WhatsappBetaEligibility> {
  return db.runTransaction(async (tx) => {
    const tenantRef = establishmentRef(id);
    const tenantSnap = await tx.get(tenantRef);
    const cohortRef = whatsappBetaCohortRef();
    const cohortSnap = await tx.get(cohortRef);
    let tenant = tenantSnap.exists ? (tenantSnap.data() as Establishment) : null;
    let claimed = 0;

    if (cohortSnap.exists) {
      const cohort = cohortSnap.data() as WhatsappBetaCohort;
      claimed = Number.isFinite(cohort.claimed) ? Math.max(0, cohort.claimed) : 0;
      if (tenant && !tenant.whatsappBeta && hadSuccessfulWhatsappConnection(tenant)) {
        const joinedAt = tenant.whatsapp?.connectedAt ?? tenant.whatsapp?.disconnectedAt ?? Date.now();
        tx.update(tenantRef, { whatsappBeta: { access: "grandfathered", joinedAt } });
        tenant = { ...tenant, whatsappBeta: { access: "grandfathered", joinedAt } };
      }
    } else {
      const now = Date.now();
      const establishments = await tx.get(db.collection("establishments"));
      const grandfathered = establishments.docs
        .map((doc) => ({ id: doc.id, data: doc.data() as Establishment }))
        .filter(({ data }) => !data.whatsappBeta && hadSuccessfulWhatsappConnection(data));
      claimed = establishments.docs.filter(
        (doc) => (doc.data() as Establishment).whatsappBeta?.access === "participant",
      ).length;

      for (const legacy of grandfathered) {
        const joinedAt = legacy.data.whatsapp?.connectedAt ?? legacy.data.whatsapp?.disconnectedAt ?? now;
        tx.update(establishmentRef(legacy.id), {
          whatsappBeta: { access: "grandfathered", joinedAt },
        });
        if (legacy.id === id && tenant) {
          tenant = { ...tenant, whatsappBeta: { access: "grandfathered", joinedAt } };
        }
      }
      tx.set(cohortRef, {
        limit: WHATSAPP_BETA_LIMIT,
        claimed,
        activatedAt: now,
        updatedAt: now,
      });
    }

    const eligibility = betaEligibilityOf(tenant);
    if (eligibility !== "available") return eligibility;
    return claimed >= WHATSAPP_BETA_LIMIT ? "cohort_full" : "available";
  });
}

// Quantos documentos inspecionar ao procurar estabelecimentos que
// compartilham um phone_number_id ou uma WABA. Um mesmo número pode aparecer
// em mais de um documento — tipicamente porque tentativas de conexão
// anteriores o gravaram e ficaram para trás como "connecting"/"disconnected".
// Na prática são pouquíssimos; o teto existe só para a query nunca ser
// ilimitada.
const TENANT_LOOKUP_CANDIDATES = 10;

// PIN cifrado que este estabelecimento já tem para ESTE número, se houver.
//
// Lê primeiro o mapa por número; se não achar, aceita o campo legado `pin`
// — mas SOMENTE quando ele se refere ao mesmo número (documentos antigos
// guardavam um PIN único, sempre o do `phoneNumberId` corrente). Nunca
// devolve o PIN de um número para outro: registrar com PIN errado é
// exatamente o erro 133005.
function storedPinFor(
  wa: EstablishmentWhatsapp | undefined,
  phoneNumberId: string,
): EncryptedToken | undefined {
  const fromMap = wa?.pinsByPhoneNumberId?.[phoneNumberId];
  if (fromMap) return fromMap;
  if (wa?.pin && wa.phoneNumberId === phoneNumberId) return wa.pin;
  return undefined;
}

// Mapa de PINs com o deste número adicionado, preservando os já existentes.
// Preservar é o ponto: o cliente pode trocar de número e voltar ao anterior
// depois, e o número antigo continua exigindo o PIN antigo na Meta.
//
// Também recolhe o `pin` legado para dentro do mapa. Sem isso, uma troca de
// número perderia o PIN do formato antigo para sempre: a claim nova
// substitui o objeto `whatsapp` inteiro, e o campo legado sairia junto —
// exatamente o cenário que o mapa existe para evitar.
function pinsWith(
  wa: EstablishmentWhatsapp | undefined,
  phoneNumberId: string,
  pin: EncryptedToken,
): Record<string, EncryptedToken> {
  const pins: Record<string, EncryptedToken> = { ...(wa?.pinsByPhoneNumberId ?? {}) };
  if (wa?.pin && wa.phoneNumberId && !pins[wa.phoneNumberId]) {
    pins[wa.phoneNumberId] = wa.pin;
  }
  pins[phoneNumberId] = pin;
  return pins;
}

// Existe OUTRO estabelecimento (≠ selfId) já conectado neste phone_number_id?
//
// Dois estabelecimentos conectados no mesmo número deixam o roteamento do
// webhook ambíguo (ver findEstablishmentByPhoneNumberId) — as mensagens
// pertencem a um só dono e não há como desempatar corretamente depois. Por
// isso a checagem acontece ANTES de assumir a claim, e não como conserto.
//
// Filtra o status em memória de propósito: uma segunda cláusula de igualdade
// em campo aninhado poderia exigir índice composto, e uma query que falha
// aqui bloquearia conexões legítimas.
async function otherConnectedEstablishmentWithNumber(
  tx: Transaction,
  phoneNumberId: string,
  selfId: string,
): Promise<string | null> {
  const query = db
    .collection("establishments")
    .where("whatsapp.phoneNumberId", "==", phoneNumberId)
    .limit(TENANT_LOOKUP_CANDIDATES);
  const snap = await tx.get(query);
  const owner = snap.docs.find(
    (d) => d.id !== selfId && (d.data() as Establishment).whatsapp?.status === "connected",
  );
  return owner?.id ?? null;
}

export type ClaimWhatsappResult =
  // Claim nova: ninguém estava conectando/conectado — o PIN já foi gerado e
  // persistido cifrado (status "connecting") DENTRO desta transação, antes
  // de retornar. attemptId é a prova de posse da lease: só quem recebeu
  // este valor pode finalizar ou liberar esta tentativa específica.
  | { outcome: "claimed"; pin: string; attemptId: string }
  // Havia uma claim "connecting" para o MESMO wabaId/phoneNumberId com a
  // lease JÁ EXPIRADA (tentativa anterior não concluiu a tempo, ou foi
  // liberada após uma falha) — reaproveita o PIN já persistido (nunca gera
  // outro) e assume uma lease NOVA com attemptId novo.
  | { outcome: "resumed"; pin: string; attemptId: string }
  // O estabelecimento havia DESCONECTADO pelo painel e está reconectando o
  // MESMO número, que já tem PIN guardado — reaproveita esse PIN. É o que
  // torna desconectar/reconectar possível: um PIN novo seria recusado pela
  // Meta com 133005, porque a verificação em 2 etapas do número continua
  // valendo mesmo depois da desconexão.
  | { outcome: "reconnected"; pin: string; attemptId: string }
  // Outro estabelecimento já está conectado neste phone_number_id. Recusa
  // antes de assumir a claim — dois donos no mesmo número tornam o
  // roteamento do webhook ambíguo e sem conserto correto depois.
  | { outcome: "number_in_use" }
  // Já há uma conexão "connected" válida — não é sobrescrita.
  | { outcome: "already_connected" }
  // Há uma lease ATIVA (outra requisição em andamento agora) para o mesmo
  // estabelecimento, ou uma claim "connecting" (com ou sem lease ativa)
  // para OUTRO wabaId/phoneNumberId — recusa por segurança, nunca sobrepõe.
  | { outcome: "conflict" };

// Tenta assumir, com EXCLUSIVIDADE, o processo de conexão de WhatsApp de um
// estabelecimento. Duas requisições concorrentes nunca recebem "resumed"/
// "claimed" ao mesmo tempo: a lease (attemptId + leaseExpiresAt) garante que
// só uma tentativa por vez tem permissão de prosseguir, mesmo quando os
// wabaId/phoneNumberId informados são idênticos — a segunda cai em
// "conflict" enquanto a lease da primeira estiver ativa.
//
// Também é aqui, e não na rota, que o PIN nasce: gerado e cifrado dentro da
// própria transação, então a claim SÓ é considerada bem-sucedida se o PIN
// cifrado já estiver gravado no Firestore — nunca depois de chamar /register.
export async function claimWhatsappConnection(
  id: string,
  wabaId: string,
  phoneNumberId: string,
): Promise<ClaimWhatsappResult> {
  const ref = establishmentRef(id);
  return db.runTransaction(async (tx) => {
    // Leituras primeiro (exigência do Firestore: nenhuma leitura depois de
    // escrever na mesma transação).
    const numberOwner = await otherConnectedEstablishmentWithNumber(tx, phoneNumberId, id);
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as Establishment).whatsapp : undefined;
    const now = Date.now();

    // Número já pertence a outro estabelecimento conectado — recusa antes de
    // tocar em qualquer coisa.
    if (numberOwner) {
      return { outcome: "number_in_use" as const };
    }

    if (existing?.status === "connected") {
      return { outcome: "already_connected" as const };
    }

    // Reconexão do MESMO número depois de uma desconexão pelo painel:
    // reaproveita o PIN guardado para ele. Se (por dados antigos ou limpeza
    // manual) não houver PIN guardado, cai adiante na claim nova e gera um —
    // é a única opção possível, e um eventual 133005 aparece com diagnóstico
    // claro em vez de estourar aqui.
    if (existing?.status === "disconnected" && existing.phoneNumberId === phoneNumberId) {
      const saved = storedPinFor(existing, phoneNumberId);
      if (saved) {
        const attemptId = randomUUID();
        tx.update(ref, {
          "whatsapp.wabaId": wabaId,
          "whatsapp.status": "connecting",
          "whatsapp.attemptId": attemptId,
          "whatsapp.leaseExpiresAt": now + WHATSAPP_CONNECT_LEASE_TTL_MS,
          "whatsapp.claimedAt": now,
          // Migra o PIN legado para o mapa na primeira reconexão, sem perder
          // nenhum PIN já registrado para outros números.
          "whatsapp.pinsByPhoneNumberId": pinsWith(existing, phoneNumberId, saved),
          "whatsapp.disconnectedAt": FieldValue.delete(),
        });
        return { outcome: "reconnected" as const, pin: decryptPin(saved), attemptId };
      }
    }

    if (existing?.status === "connecting") {
      const leaseActive =
        typeof existing.leaseExpiresAt === "number" && existing.leaseExpiresAt > now;

      // Lease ainda válida: ninguém mais assume, IDs iguais ou não.
      if (leaseActive) {
        return { outcome: "conflict" as const };
      }

      // Lease expirada (ou liberada após falha) — só retoma se for
      // exatamente a MESMA WABA/número da tentativa anterior; IDs
      // diferentes continuam em conflito mesmo sem lease ativa, para nunca
      // sobrescrever silenciosamente uma claim de outra tentativa.
      if (existing.wabaId !== wabaId || existing.phoneNumberId !== phoneNumberId) {
        return { outcome: "conflict" as const };
      }

      // Sem PIN guardado para este número (documento antigo ou limpo
      // manualmente) não há o que retomar — cai na claim nova abaixo, que
      // gera um PIN.
      const saved = storedPinFor(existing, phoneNumberId);
      if (saved) {
        const attemptId = randomUUID();
        tx.update(ref, {
          "whatsapp.attemptId": attemptId,
          "whatsapp.leaseExpiresAt": now + WHATSAPP_CONNECT_LEASE_TTL_MS,
          "whatsapp.claimedAt": now,
          "whatsapp.pinsByPhoneNumberId": pinsWith(existing, phoneNumberId, saved),
        });
        return { outcome: "resumed" as const, pin: decryptPin(saved), attemptId };
      }
    }

    // Claim nova: primeira conexão do estabelecimento, ou troca para um
    // número diferente do que estava guardado.
    //
    // O mapa de PINs dos números ANTERIORES é preservado de propósito: este
    // update substitui o objeto `whatsapp` inteiro, e sem carregar o mapa
    // adiante o PIN do número antigo se perderia — impedindo o cliente de
    // voltar para ele depois (a Meta continuaria exigindo aquele PIN).
    const pin = generateRandomPin();
    const encryptedPin = encryptPin(pin);
    const attemptId = randomUUID();
    const whatsapp = {
      wabaId,
      phoneNumberId,
      status: "connecting" as const,
      pinsByPhoneNumberId: pinsWith(existing, phoneNumberId, encryptedPin),
      attemptId,
      claimedAt: now,
      leaseExpiresAt: now + WHATSAPP_CONNECT_LEASE_TTL_MS,
    };
    if (snap.exists) {
      tx.update(ref, { whatsapp });
    } else {
      // Conta nova que ainda não passou pelo painel/config — cria o doc
      // mínimo do estabelecimento junto (mesmo padrão do
      // upsertEstablishmentConfig), já com a claim.
      const base: Establishment = {
        id,
        name: "",
        type: "outro",
        ownerUid: id,
        status: "active",
        createdAt: now,
        bot: defaultBotConfig(),
        whatsapp,
      };
      tx.set(ref, base);
    }
    return { outcome: "claimed" as const, pin, attemptId };
  });
}

// Conclui a conexão: chamada só depois que TODA a sequência obrigatória
// (exchange, verificação de posse, subscribe, register) já teve sucesso.
// Verifica, na MESMA transação, que a lease ainda pertence a este
// `attemptId` — se outra tentativa já assumiu (nossa lease expirou no meio
// do caminho e alguém mais tomou posse) ou a conexão já foi concluída por
// outro caminho, esta função recusa escrever "connected" e devolve
// `{ ok: false }`. Preserva os PINs já persistidos pela claim (nunca
// reescritos aqui) — inclusive os de números anteriores, que continuam
// necessários se o cliente voltar para um deles; attemptId/leaseExpiresAt são
// removidos por não fazerem mais sentido depois de "connected".
export async function finalizeWhatsappConnection(
  id: string,
  attemptId: string,
  data: {
    wabaId: string;
    phoneNumberId: string;
    accessToken: EncryptedToken;
    connectionMode: WhatsappConnectionMode;
    registeredAt?: number;
  },
): Promise<
  | { ok: true; betaOutcome: "claimed" | "already_participant" | "grandfathered" }
  | { ok: false; reason: "stale_attempt" | "cohort_full" }
> {
  const ref = establishmentRef(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const tenant = snap.exists ? (snap.data() as Establishment) : undefined;
    const existing = tenant?.whatsapp;

    if (!existing || existing.status !== "connecting" || existing.attemptId !== attemptId) {
      return { ok: false, reason: "stale_attempt" as const };
    }

    const now = Date.now();
    const cohortRef = whatsappBetaCohortRef();
    const cohortSnap = await tx.get(cohortRef);
    const existingBetaAccess = tenant?.whatsappBeta?.access;
    const alreadyEligible = existingBetaAccess === "participant" || existingBetaAccess === "grandfathered";
    let claimed = 0;
    let activatedAt = now;
    let legacyConnections: Array<{ id: string; joinedAt: number }> = [];

    if (cohortSnap.exists) {
      const cohort = cohortSnap.data() as WhatsappBetaCohort;
      claimed = Number.isFinite(cohort.claimed) ? Math.max(0, cohort.claimed) : 0;
      activatedAt = cohort.activatedAt || now;
    } else {
      // Fallback defensivo para chamadores internos que não fizeram a
      // pré-checagem da rota. Em produção, getWhatsappBetaEligibility cria
      // o cohort e classifica legados antes de claimWhatsappConnection.
      const establishments = await tx.get(db.collection("establishments"));
      claimed = establishments.docs.filter(
        (doc) => (doc.data() as Establishment).whatsappBeta?.access === "participant",
      ).length;
      legacyConnections = establishments.docs
        .map((doc) => ({ id: doc.id, data: doc.data() as Establishment }))
        .filter(({ data }) => !data.whatsappBeta && hadSuccessfulWhatsappConnection(data))
        .map(({ id: legacyId, data }) => ({
          id: legacyId,
          joinedAt: data.whatsapp?.connectedAt ?? data.whatsapp?.disconnectedAt ?? now,
        }));
    }

    if (!alreadyEligible && claimed >= WHATSAPP_BETA_LIMIT) {
      return { ok: false, reason: "cohort_full" as const };
    }

    const betaOutcome = existingBetaAccess === "participant"
      ? "already_participant" as const
      : existingBetaAccess === "grandfathered"
        ? "grandfathered" as const
        : "claimed" as const;
    if (!alreadyEligible) claimed += 1;

    for (const legacy of legacyConnections) {
      tx.update(establishmentRef(legacy.id), {
        whatsappBeta: { access: "grandfathered", joinedAt: legacy.joinedAt },
      });
    }
    tx.set(cohortRef, { limit: WHATSAPP_BETA_LIMIT, claimed, activatedAt, updatedAt: now }, { merge: true });
    tx.update(ref, {
      "whatsapp.wabaId": data.wabaId,
      "whatsapp.phoneNumberId": data.phoneNumberId,
      "whatsapp.connectionMode": data.connectionMode,
      "whatsapp.accessToken": data.accessToken,
      "whatsapp.status": "connected",
      "whatsapp.connectedAt": now,
      "whatsapp.tokenRefreshedAt": now,
      "whatsapp.attemptId": FieldValue.delete(),
      "whatsapp.leaseExpiresAt": FieldValue.delete(),
      ...(!alreadyEligible ? { whatsappBeta: { access: "participant", joinedAt: now } } : {}),
      ...(data.registeredAt !== undefined ? { "whatsapp.registeredAt": data.registeredAt } : {}),
    });
    return { ok: true, betaOutcome };
  });
}

// Libera a lease de uma tentativa que falhou (exchange/ownership/subscribe/
// register) ANTES do TTL expirar naturalmente — permite uma nova tentativa
// imediata sem obrigar o estabelecimento a esperar. NUNCA apaga o `pin`
// cifrado nem move o status para longe de "connecting": o registro
// permanece recuperável, só a exclusividade é liberada (leaseExpiresAt
// jogado para o passado — a próxima claim com o MESMO wabaId/phoneNumberId
// entra pelo caminho de "resumed" e reaproveita o PIN).
//
// Verifica `attemptId` antes de liberar: se esta já não é mais a tentativa
// ativa (outra já assumiu, ou já finalizou), não faz nada — nunca libera
// uma lease que não é sua.
export async function releaseWhatsappConnectionAttempt(
  id: string,
  attemptId: string,
): Promise<void> {
  const ref = establishmentRef(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as Establishment).whatsapp : undefined;
    if (!existing || existing.status !== "connecting" || existing.attemptId !== attemptId) {
      return;
    }
    tx.update(ref, {
      "whatsapp.leaseExpiresAt": Date.now() - 1,
      "whatsapp.attemptId": FieldValue.delete(),
    });
  });
}

// Algum OUTRO estabelecimento (≠ selfId) está conectado usando esta MESMA
// WABA? A inscrição de webhooks da Meta é por WABA, não por número — remover
// a inscrição por causa de uma desconexão derrubaria os webhooks de todos os
// outros números daquela WABA. Quem desconecta só pode desinscrever se a
// resposta aqui for `false`.
export async function hasOtherConnectedEstablishmentWithWaba(
  wabaId: string,
  selfId: string,
): Promise<boolean> {
  const snap = await db
    .collection("establishments")
    .where("whatsapp.wabaId", "==", wabaId)
    .limit(TENANT_LOOKUP_CANDIDATES)
    .get();
  return snap.docs.some(
    (d) => d.id !== selfId && (d.data() as Establishment).whatsapp?.status === "connected",
  );
}

export type DisconnectWhatsappResult =
  // Estava conectado e foi desconectado agora.
  | { outcome: "disconnected" }
  // Não havia conexão (nunca conectou, ou já estava desconectado) — tratado
  // como sucesso idempotente: um botão não deve dar erro por clique repetido.
  | { outcome: "already_disconnected" }
  // Há uma tentativa de conexão em andamento com lease ativa — desconectar
  // agora correria com o finalize dela.
  | { outcome: "in_progress" };

// Desconecta o WhatsApp do estabelecimento: a Livia para de enviar e de
// atender por aquele número, mas NADA do negócio é apagado.
//
// O que é preservado, e por quê:
//   - `pinsByPhoneNumberId` (e o `pin` legado): o PIN de 2 etapas pertence ao
//     NÚMERO na Meta e continua valendo depois da desconexão — sem ele, uma
//     reconexão futura geraria um PIN novo e a Meta recusaria com 133005;
//   - `wabaId`/`phoneNumberId`: identificam o número para reconectar depois e
//     permitem casar com o PIN certo. Manter o phoneNumberId aqui só é seguro
//     porque o webhook passou a exigir status "connected" (ver
//     findEstablishmentByPhoneNumberId);
//   - `registeredAt`: histórico de que a Livia registrou o número.
//
// O que sai: `accessToken` (a credencial em si — a reconexão emite outra) e os
// campos que descrevem uma conexão ativa. Conversas, mensagens, agenda e base
// de conhecimento vivem em subcoleções e não são tocadas.
//
// NÃO faz deregister do número na Meta: desconectar da Livia não pode
// desmontar a configuração de WhatsApp do cliente. A remoção da inscrição de
// webhooks é responsabilidade do chamador (precisa do accessToken e da guarda
// de WABA compartilhada) — ver app/api/whatsapp/disconnect/route.ts.
export async function disconnectWhatsapp(id: string): Promise<DisconnectWhatsappResult> {
  const ref = establishmentRef(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const tenant = snap.exists ? (snap.data() as Establishment) : undefined;
    const existing = tenant?.whatsapp;

    if (!existing || existing.status === "disconnected") {
      return { outcome: "already_disconnected" as const };
    }

    if (existing.status === "connecting") {
      const leaseActive =
        typeof existing.leaseExpiresAt === "number" && existing.leaseExpiresAt > Date.now();
      if (leaseActive) return { outcome: "in_progress" as const };
      // Lease expirada: é uma tentativa abandonada, não uma conexão viva.
      // Segue para a limpeza abaixo, que a encerra formalmente.
    }

    tx.update(ref, {
      "whatsapp.status": "disconnected",
      "whatsapp.disconnectedAt": Date.now(),
      "whatsapp.accessToken": FieldValue.delete(),
      "whatsapp.connectedAt": FieldValue.delete(),
      "whatsapp.tokenRefreshedAt": FieldValue.delete(),
      "whatsapp.attemptId": FieldValue.delete(),
      "whatsapp.leaseExpiresAt": FieldValue.delete(),
      ...(existing.status === "connected" && !tenant?.whatsappBeta
        ? { whatsappBeta: { access: "grandfathered", joinedAt: existing.connectedAt ?? Date.now() } }
        : {}),
    });
    return { outcome: "disconnected" as const };
  });
}

// Acha o estabelecimento CONECTADO dono de um phone_number_id (o webhook
// chega com ele).
//
// O filtro por status é aplicado DEPOIS de buscar os candidatos, de
// propósito: uma segunda cláusula de igualdade em campo aninhado
// (whatsapp.status) poderia exigir um índice composto, e uma query que falha
// aqui derruba o atendimento inteiro — o webhook engole a exceção e a
// mensagem some. Buscar por phoneNumberId usa o índice de campo único que o
// Firestore já mantém sozinho, e a filtragem em memória sobre um punhado de
// documentos é irrelevante em custo.
//
// ANTES este método fazia `.limit(1)` e devolvia um documento QUALQUER com
// aquele número, deixando o webhook checar o status depois. Com dois
// estabelecimentos compartilhando o mesmo phone_number_id, o Firestore podia
// devolver o não conectado — e o webhook descartava a mensagem em silêncio,
// sem procurar o outro. Era não determinístico: a mesma conta podia receber
// ou perder mensagens entre requisições.
export async function findEstablishmentByPhoneNumberId(
  phoneNumberId: string,
): Promise<Establishment | null> {
  const snap = await db
    .collection("establishments")
    .where("whatsapp.phoneNumberId", "==", phoneNumberId)
    .limit(TENANT_LOOKUP_CANDIDATES)
    .get();

  const connected = snap.docs
    .map((d) => d.data() as Establishment)
    .filter((est) => est.whatsapp?.status === "connected");

  if (connected.length === 0) return null;

  // Mais de um estabelecimento CONECTADO no mesmo número é um estado
  // inválido que este código não tem como desempatar corretamente (as
  // mensagens pertencem a um só dono). Não adivinha em silêncio: registra
  // para investigação e segue com o primeiro, mantendo o atendimento de pé.
  if (connected.length > 1) {
    console.error(
      `[livia webhook] número conectado em ${connected.length} estabelecimentos; usando o primeiro; corrigir os dados.`,
    );
  }

  return connected[0]!;
}

export async function getKnowledgeBase(
  establishmentId: string,
): Promise<KnowledgeBase | null> {
  const doc = await sub(establishmentId, "meta").doc("knowledge").get();
  return doc.exists ? (doc.data() as KnowledgeBase) : null;
}

// Salva (merge) a base de conhecimento do estabelecimento.
export async function saveKnowledgeBase(
  establishmentId: string,
  data: Omit<KnowledgeBase, "establishmentId" | "updatedAt">,
): Promise<KnowledgeBase> {
  const kb: KnowledgeBase = {
    ...data,
    establishmentId,
    updatedAt: Date.now(),
  };
  await sub(establishmentId, "meta").doc("knowledge").set(kb);
  return kb;
}

// ---- Ensinar a Lívia (Passo 8) ----
// A correção SEMPRE passa por aqui: só duas escritas acontecem — um
// registro de auditoria em establishments/{id}/corrections (append-only,
// nunca editado depois) e uma mudança na própria KnowledgeBase (via
// getKnowledgeBase/saveKnowledgeBase, já existentes). Nenhuma outra coleção
// é tocada — não há como uma correção alcançar Establishment.whatsapp,
// Appointment ou qualquer dado de integração, porque esta função nunca
// importa as funções que escrevem lá.
export async function applyKnowledgeCorrection(
  establishmentId: string,
  input: {
    category: CorrectionCategory;
    question: string | null;
    correctText: string;
    conversationId: string | null;
  },
): Promise<KnowledgeCorrection> {
  const now = Date.now();
  const ref = sub(establishmentId, "corrections").doc();
  const correction: KnowledgeCorrection = {
    id: ref.id,
    establishmentId,
    category: input.category,
    question: input.category === "faq" ? input.question : null,
    correctText: input.correctText,
    conversationId: input.conversationId,
    createdAt: now,
  };
  await ref.set(correction);

  const kb = (await getKnowledgeBase(establishmentId)) ?? {
    establishmentId,
    about: "",
    address: null,
    hours: null,
    services: [],
    faqs: [],
    notes: null,
    paymentMethods: null,
    importantInfo: null,
    toneGuidelines: null,
    prohibitions: null,
    handoffTriggers: null,
    updatedAt: now,
  };

  if (correction.category === "faq" && correction.question) {
    // Substitui uma FAQ existente com a MESMA pergunta (comparação
    // case-insensitive) em vez de duplicar — é o caso comum de "a Livia
    // respondeu errado a uma pergunta que já estava cadastrada".
    const normalizedQ = correction.question.trim().toLowerCase();
    const idx = kb.faqs.findIndex((f) => f.question.trim().toLowerCase() === normalizedQ);
    const entry = { question: correction.question, answer: correction.correctText };
    const faqs = idx >= 0 ? kb.faqs.map((f, i) => (i === idx ? entry : f)) : [...kb.faqs, entry];
    await saveKnowledgeBase(establishmentId, { ...kb, faqs });
  } else {
    // Demais categorias: anexa como observação datada e rotulada em
    // `notes` — campo de texto livre que já entra no prompt
    // (lib/ai/brain.ts: knowledgeToText). Nunca sobrescreve o que já
    // existia lá, só acrescenta.
    const label = CORRECTION_CATEGORY_LABEL[correction.category];
    const dateStr = new Date(now).toLocaleDateString("pt-BR");
    const line = `[${label} — ${dateStr}] ${correction.correctText}`;
    const notes = kb.notes ? `${kb.notes}
${line}` : line;
    await saveKnowledgeBase(establishmentId, { ...kb, notes });
  }

  return correction;
}

const CORRECTION_CATEGORY_LABEL: Record<CorrectionCategory, string> = {
  faq: "FAQ",
  establishment_info: "Informação do estabelecimento",
  business_rule: "Regra do negócio",
  communication_preference: "Preferência de comunicação",
  operational_knowledge: "Conhecimento operacional",
};

export async function listKnowledgeCorrections(
  establishmentId: string,
  limitCount = 20,
): Promise<KnowledgeCorrection[]> {
  const snap = await sub(establishmentId, "corrections")
    .orderBy("createdAt", "desc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as KnowledgeCorrection);
}

// ---- Fila de pendências (Passo 9) ----
// Doc id = conversationId — no máximo uma pendência ativa por conversa
// nesta V1, então reavaliar a mesma conversa em mensagens seguintes
// ATUALIZA o mesmo documento em vez de criar outro (é a deduplicação
// exigida pelo plano, sem precisar de query nem de lógica extra).
export async function upsertPendingTask(
  establishmentId: string,
  conversationId: string,
  contactPhone: string,
  draft: { type: PendingTaskType; waitingFor: string; dueAt?: number },
): Promise<void> {
  const ref = sub(establishmentId, "pendingTasks").doc(conversationId);
  const now = Date.now();
  const snap = await ref.get();

  if (snap.exists) {
    await ref.update({
      type: draft.type,
      waitingFor: draft.waitingFor,
      status: "open",
      updatedAt: now,
      resolvedAt: null,
      dueAt: draft.dueAt ?? null,
    });
    return;
  }

  const task: PendingTask = {
    id: conversationId,
    establishmentId,
    conversationId,
    contactPhone,
    type: draft.type,
    waitingFor: draft.waitingFor,
    status: "open",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    dueAt: draft.dueAt ?? null,
  };
  await ref.set(task);
}

// Best-effort: só escreve se havia mesmo uma pendência aberta pra essa
// conversa — evita uma escrita no caminho comum (a maioria das mensagens
// não tem nenhuma pendência aberta pra resolver).
export async function resolvePendingTask(establishmentId: string, conversationId: string): Promise<void> {
  const ref = sub(establishmentId, "pendingTasks").doc(conversationId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const existing = snap.data() as PendingTask;
  if (existing.status === "resolved") return;
  await ref.update({ status: "resolved", resolvedAt: Date.now(), updatedAt: Date.now() });
}

// Pendência (aberta ou já resolvida) de UMA conversa específica — usado na
// ficha de um cliente (Passo 10) e em checagens pontuais. Diferente de
// listPendingTasks (que só lista as abertas): aqui é sempre 1 leitura por
// id, sem query.
export async function getPendingTask(
  establishmentId: string,
  conversationId: string,
): Promise<PendingTask | null> {
  const doc = await sub(establishmentId, "pendingTasks").doc(conversationId).get();
  return doc.exists ? (doc.data() as PendingTask) : null;
}

// Lista de pendências abertas — usada pela caixa de entrada (Passo 11) e
// pelas oportunidades (Passo 12).
export async function listPendingTasks(
  establishmentId: string,
  limitCount = 50,
): Promise<PendingTask[]> {
  // Só a igualdade na query (sem orderBy) — combinar `.where("status", "==",
  // ...)` com `.orderBy("updatedAt", ...)` exige um índice composto que este
  // projeto não tem, e a query falha em Production com FAILED_PRECONDITION
  // (foi exatamente o que quebrou GET /api/conversations depois do Pacote 3
  // passar a chamar esta função pela primeira vez). Ordena em memória depois
  // — mesmo padrão já usado em findEstablishmentByPhoneNumberId (c7982fd) e
  // documentado em todo o Pacote 3 como restrição deliberada; esta função
  // só não tinha seguido a própria regra.
  const snap = await sub(establishmentId, "pendingTasks")
    .where("status", "==", "open")
    .limit(limitCount)
    .get();
  return snap.docs
    .map((d) => d.data() as PendingTask)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---- Memória do cliente (Fase 1) ----
// establishments/{id}/customers/{telefone normalizado} — mesmo id usado por
// Conversation, então os dois documentos sempre correspondem ao mesmo
// contato dentro do tenant.

export async function getCustomerProfile(
  establishmentId: string,
  phone: string,
): Promise<CustomerProfile | null> {
  const id = normalizePhone(phone);
  const doc = await sub(establishmentId, "customers").doc(id).get();
  return doc.exists ? (doc.data() as CustomerProfile) : null;
}

// Patch determinístico: só campos que o CHAMADOR já sabe com certeza (nome
// vindo do cartão de contato do WhatsApp, serviço de um agendamento
// realmente criado, intenção do classificador determinístico). Esta função
// não julga a qualidade do dado — quem chama é responsável por nunca passar
// uma inferência fraca da IA aqui. `undefined` num campo significa "não
// atualizar", nunca "apagar" — um dado confiável já salvo não é substituído
// por ausência de informação numa mensagem posterior.
export async function upsertCustomerProfile(
  establishmentId: string,
  phone: string,
  patch: Partial<
    Pick<
      CustomerProfile,
      "name" | "preferredProfessional" | "preferredTime" | "frequentAddress" | "lastService" | "lastIntent"
    >
  >,
): Promise<void> {
  const id = normalizePhone(phone);
  const ref = sub(establishmentId, "customers").doc(id);
  const now = Date.now();
  const snap = await ref.get();

  const fields: Record<string, unknown> = { lastInteractionAt: now, updatedAt: now };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) fields[key] = value;
  }

  if (snap.exists) {
    // Telefone é o identificador único do cliente: uma vez que o nome já
    // está cadastrado, uma variação vinda de uma mensagem/conversa nova
    // (ex.: "niltinho" numa sessão, "Nilton" noutra) nunca pode substituí-lo.
    // Só grava `name` aqui quando o cadastro existente ainda não tem nome —
    // completar um dado ausente é diferente de sobrescrever um já existente.
    const existingName = (snap.data() as CustomerProfile).name;
    if (existingName) delete fields.name;
    await ref.update(fields);
    return;
  }

  const profile: CustomerProfile = {
    phone: id,
    establishmentId,
    name: patch.name ?? null,
    preferredProfessional: patch.preferredProfessional ?? null,
    preferredTime: patch.preferredTime ?? null,
    frequentAddress: patch.frequentAddress ?? null,
    lastService: patch.lastService ?? null,
    lastIntent: patch.lastIntent ?? null,
    notes: null,
    lastInteractionAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(profile);
}

// Lista de perfis pra tela de CRM (Passo 10) — mais recentes primeiro. Só
// os campos do próprio CustomerProfile: nenhuma junção com conversas,
// agendamentos ou pendências aqui (isso é responsabilidade da rota de
// detalhe de UM cliente, não desta listagem — evita N+1 ao carregar a
// lista inteira).
export async function listCustomerProfiles(
  establishmentId: string,
  limitCount = 200,
): Promise<CustomerProfile[]> {
  const snap = await sub(establishmentId, "customers")
    .orderBy("lastInteractionAt", "desc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as CustomerProfile);
}

// ---- Campanhas (fundação) ----
// Campanhas vivem na subcoleção do estabelecimento e nunca aceitam tenant de
// payload HTTP: futuras rotas devem resolver establishmentId pela sessão, no
// mesmo padrão das rotas atuais.

const EMPTY_CAMPAIGN_COUNTERS: Campaign["counters"] = {
  total: 0,
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  replied: 0,
  skipped: 0,
};

export async function createCampaign(
  establishmentId: string,
  input: { name: string },
): Promise<Campaign> {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new Error("Nome da campanha inválido.");

  const now = Date.now();
  const campaign: Campaign = {
    id: randomUUID(),
    establishmentId,
    name,
    status: "draft",
    scheduledAt: null,
    startedAt: null,
    finishedAt: null,
    counters: { ...EMPTY_CAMPAIGN_COUNTERS },
    createdAt: now,
    updatedAt: now,
  };
  await sub(establishmentId, "campaigns").doc(campaign.id).create(campaign);
  return campaign;
}

export async function getCampaign(
  establishmentId: string,
  campaignId: string,
): Promise<Campaign | null> {
  const doc = await sub(establishmentId, "campaigns").doc(campaignId).get();
  return doc.exists ? (doc.data() as Campaign) : null;
}

export async function listCampaigns(establishmentId: string): Promise<Campaign[]> {
  const snap = await sub(establishmentId, "campaigns").orderBy("createdAt", "desc").limit(100).get();
  return snap.docs.map((doc) => doc.data() as Campaign);
}

export async function listCampaignRecipients(establishmentId: string, campaignId: string): Promise<CampaignRecipient[]> {
  const campaign = await getCampaign(establishmentId, campaignId);
  if (!campaign) return [];
  const snap = await sub(establishmentId, "campaignRecipients").where("campaignId", "==", campaignId).limit(1000).get();
  return snap.docs.map((doc) => doc.data() as CampaignRecipient);
}

/** Total de destinatários já materializados em campanhas do tenant.
 * Durante o trial, este total funciona como cota acumulada entre TODAS as
 * campanhas: 10x10, 5x20 ou 1x100 consomem a mesma cota de 100. */
export async function countTrialCampaignRecipients(establishmentId: string): Promise<number> {
  const snap = await sub(establishmentId, "campaignRecipients").count().get();
  return snap.data().count;
}

/** Remove somente um rascunho que falhou durante a preparação e seus
 * recipients parciais. Campanhas preparadas/ativas nunca são apagadas aqui. */
export async function deleteDraftCampaign(establishmentId: string, campaignId: string): Promise<boolean> {
  const campaign = await getCampaign(establishmentId, campaignId);
  if (!campaign || campaign.status !== "draft") return false;
  const recipients = await sub(establishmentId, "campaignRecipients")
    .where("campaignId", "==", campaignId)
    .limit(MAX_SYNCHRONOUS_AUDIENCE)
    .get();
  const batch = db.batch();
  for (const recipient of recipients.docs) batch.delete(recipient.ref);
  batch.delete(sub(establishmentId, "campaigns").doc(campaignId));
  await batch.commit();
  return true;
}

export type CampaignAudienceSelection = "all_eligible" | "selected";
export interface PrepareCampaignAudienceInput {
  selection: CampaignAudienceSelection;
  phones?: string[];
  template: CampaignTemplateSnapshot;
}

export interface PrepareCampaignAudienceResult {
  campaign: Campaign;
  selected: number;
  eligible: number;
  excluded: number;
  recipientsCreated: number;
}

export interface CampaignAudiencePreview {
  selected: number;
  eligible: number;
  excluded: number;
}

/** Conta a audiência a partir dos CustomerProfiles do próprio tenant. É só
 * prévia: o snapshot materializado e a revalidação no dispatcher continuam
 * sendo as autoridades para o envio. */
export async function previewCampaignAudience(establishmentId: string): Promise<CampaignAudiencePreview> {
  const customers = await sub(establishmentId, "customers").get();
  const phones = new Map<string, CustomerProfile>();
  for (const doc of customers.docs) {
    const profile = doc.data() as CustomerProfile;
    const phone = normalizeMarketingImportPhone(doc.id) ?? normalizeMarketingImportPhone(profile.phone);
    if (phone) phones.set(phone, profile);
  }
  let eligible = 0;
  for (const profile of phones.values()) if (marketingEligibilityOf(profile).eligible) eligible++;
  return { selected: phones.size, eligible, excluded: phones.size - eligible };
}

const MAX_SYNCHRONOUS_AUDIENCE = 200;

/** Materializa uma audiência pequena e idempotente. O recipient é snapshot
 * operacional, não autorização: o dispatcher deve revalidar o CustomerProfile
 * imediatamente antes do envio. */
export async function prepareCampaignAudience(
  establishmentId: string,
  campaignId: string,
  input: PrepareCampaignAudienceInput,
): Promise<PrepareCampaignAudienceResult> {
  const campaign = await getCampaign(establishmentId, campaignId);
  if (!campaign || campaign.status !== "draft") throw new Error("Campanha não encontrada ou não está em rascunho.");
  if (input.template.status !== "APPROVED" || input.template.senderCompatible !== true) {
    throw new Error("Template não aprovado ou incompatível com o sender atual.");
  }
  const customers = await sub(establishmentId, "customers").get();
  const byPhone = new Map<string, CustomerProfile>();
  for (const doc of customers.docs) {
    const profile = doc.data() as CustomerProfile;
    const phone = normalizeMarketingImportPhone(doc.id) ?? normalizeMarketingImportPhone(profile.phone);
    if (phone) byPhone.set(phone, profile);
  }
  const requested = input.selection === "all_eligible"
    ? [...byPhone.keys()]
    : [...new Set((input.phones ?? []).map((phone) => normalizeMarketingImportPhone(phone)).filter((phone): phone is string => !!phone))];
  if (requested.length > MAX_SYNCHRONOUS_AUDIENCE) throw new Error("Audiência excede o limite síncrono; use processamento em lotes.");
  const selected = requested.length;
  let eligible = 0;
  let excluded = 0;
  let recipientsCreated = 0;
  for (const phone of requested) {
    const profile = byPhone.get(phone);
    if (!profile || !marketingEligibilityOf(profile).eligible) { excluded++; continue; }
    eligible++;
    const recipientId = `${campaignId}_${phone}`;
    const recipient: CampaignRecipient = {
      id: recipientId,
      establishmentId,
      campaignId,
      customerPhone: phone,
      ...(profile.name ? { customerName: profile.name } : {}),
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
    };
    const ref = sub(establishmentId, "campaignRecipients").doc(recipientId);
    try { await ref.create(recipient); recipientsCreated++; } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as Error & { code?: number }).code === 6)) throw error;
    }
  }
  const now = Date.now();
  const snapshot: CampaignAudienceSnapshot = {
    selectedCount: selected,
    eligibleRecipientCount: eligible,
    excludedCount: excluded,
    selection: input.selection,
    selectedAt: now,
  };
  const updated: Campaign = {
    ...campaign,
    template: input.template,
    audience: snapshot,
    counters: { ...campaign.counters, total: eligible, queued: eligible },
    updatedAt: now,
  };
  await sub(establishmentId, "campaigns").doc(campaignId).set(updated);
  return { campaign: updated, selected, eligible, excluded, recipientsCreated };
}

export type ActivateCampaignMode = "now" | "scheduled";
export type ActivateCampaignResult =
  | { kind: "activated"; campaign: Campaign }
  | { kind: "already_activated"; campaign: Campaign }
  | { kind: "invalid"; reason: string };

/**
 * Faz a transição única de uma campanha preparada para a fila do dispatcher.
 * A confirmação é persistida dentro da transação da campanha: retries HTTP
 * não podem iniciar uma segunda vez. Validações de audiência/template ficam
 * aqui para que o endpoint e qualquer futura superfície administrativa
 * compartilhem o mesmo contrato.
 */
export async function activateCampaign(
  establishmentId: string,
  campaignId: string,
  options: { mode: ActivateCampaignMode; scheduledAt?: number | null; maxRecipients: number; now?: number },
): Promise<ActivateCampaignResult> {
  const now = options.now ?? Date.now();
  const campaignRef = sub(establishmentId, "campaigns").doc(campaignId);
  const recipientsCol = sub(establishmentId, "campaignRecipients");
  const campaign = await getCampaign(establishmentId, campaignId);
  if (!campaign) return { kind: "invalid", reason: "campaign_not_found" };
  if (campaign.status !== "draft") return { kind: "already_activated", campaign };
  if (!campaign.audience || campaign.audience.eligibleRecipientCount < 1) {
    return { kind: "invalid", reason: "audience_required" };
  }
  if (!campaign.template || campaign.template.status !== "APPROVED" || campaign.template.senderCompatible !== true || !templateParameterBindingsAreValid(campaign.template.components, campaign.template.parameterBindings)) {
    return { kind: "invalid", reason: "approved_compatible_template_required" };
  }
  const recipients = await recipientsCol.where("campaignId", "==", campaignId).limit(options.maxRecipients + 1).get();
  if (recipients.empty) return { kind: "invalid", reason: "recipients_required" };
  if (recipients.docs.length > options.maxRecipients) return { kind: "invalid", reason: "recipient_limit_exceeded" };
  if (recipients.docs.length !== campaign.audience.eligibleRecipientCount) {
    return { kind: "invalid", reason: "recipient_snapshot_mismatch" };
  }
  const scheduledAt = options.mode === "scheduled" ? options.scheduledAt ?? null : null;
  if (options.mode === "scheduled" && (!scheduledAt || scheduledAt <= now)) {
    return { kind: "invalid", reason: "scheduled_at_must_be_future" };
  }
  const status = options.mode === "scheduled" ? "scheduled" : "running";
  const activated = { ...campaign, status: status as Campaign["status"], scheduledAt, startedAt: status === "running" ? now : null, activatedAt: now, updatedAt: now };
  const result = await db.runTransaction(async (tx) => {
    const currentSnap = await tx.get(campaignRef);
    if (!currentSnap.exists) return { kind: "invalid" as const, reason: "campaign_not_found" };
    const current = currentSnap.data() as Campaign;
    if (current.status !== "draft") return { kind: "already_activated" as const, campaign: current };
    tx.update(campaignRef, activated);
    return { kind: "activated" as const, campaign: activated };
  });
  return result;
}

/** Transiciona scheduled vencida sem expor a campanha a uma segunda fila. */
export async function startDueScheduledCampaign(
  establishmentId: string,
  campaignId: string,
  now = Date.now(),
): Promise<Campaign | null> {
  const ref = sub(establishmentId, "campaigns").doc(campaignId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as Campaign;
    if (current.status !== "scheduled" || !current.scheduledAt || current.scheduledAt > now) return current;
    const updated = { ...current, status: "running" as const, startedAt: current.startedAt ?? now, updatedAt: now };
    tx.update(ref, updated);
    return updated;
  });
}

/** Marca completed somente quando não há recipient que ainda possa ser processado. */
export async function completeCampaignIfDrained(
  establishmentId: string,
  campaignId: string,
  now = Date.now(),
): Promise<boolean> {
  const campaignRef = sub(establishmentId, "campaigns").doc(campaignId);
  return db.runTransaction(async (tx) => {
    // A consulta precisa estar dentro da mesma transação que grava
    // `completed`: um claim concorrente altera um documento lido pela query,
    // fazendo o Firestore reexecutar a transação em vez de concluir cedo.
    const recipientsSnap = await tx.get(
      sub(establishmentId, "campaignRecipients").where("campaignId", "==", campaignId).limit(1000),
    );
    const currentSnap = await tx.get(campaignRef);
    if (!currentSnap.exists) return false;
    const current = currentSnap.data() as Campaign;
    if (current.status !== "running") return current.status === "completed";
    const drained = recipientsSnap.docs.every((doc) => {
      const status = (doc.data() as CampaignRecipient).status;
      return status !== "pending" && status !== "queued" && status !== "leased";
    });
    if (!drained) return false;
    tx.update(campaignRef, { status: "completed", finishedAt: now, updatedAt: now });
    return true;
  });
}

// ---- Dispatcher de Campanhas (CAMPANHAS-06) ----
// Claim/lease transacional por recipient (um documento por transação, mesmo
// padrão de attemptId/leaseExpiresAt já usado no connect-claim do WhatsApp
// em EstablishmentWhatsapp) + finalização idempotente dos counters. A
// estratégia completa (lease, crash pós-Meta, retry/backoff, rate control)
// está documentada em docs/CAMPANHAS.md, seção "Dispatcher". Esta camada só
// cuida de dados; elegibilidade e chamada à Meta ficam em
// lib/campaignDispatcher.ts — nunca aqui.

export const CAMPAIGN_DISPATCH_DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;
export const CAMPAIGN_DISPATCH_MAX_BATCH = 50;

function bumpCampaignCounters(
  counters: Campaign["counters"],
  bucket: "sent" | "failed" | "skipped",
): Campaign["counters"] {
  return { ...counters, queued: Math.max(0, counters.queued - 1), [bucket]: counters[bucket] + 1 };
}

export interface ClaimCampaignRecipientsOptions {
  batchSize?: number;
  leaseTtlMs?: number;
  now?: number;
}

/**
 * Adquire lease exclusivo num pequeno lote de recipients pending/queued
 * (com nextAttemptAt já vencido) e recupera leases "leased" expirados.
 *
 * Um lease expirado só é reclamado se `leaseAttemptStarted` nunca chegou a
 * `true` durante ele. Se chegou, o worker anterior pode ter morrido DEPOIS
 * de a Meta já ter aceitado o envio — nesse caso o recipient é finalizado
 * direto como failed+ambiguous (counters avançam) e NUNCA é reclamado de
 * novo automaticamente, para nunca reenviar mensagem duplicada.
 */
export async function claimCampaignRecipients(
  establishmentId: string,
  campaignId: string,
  workerId: string,
  options: ClaimCampaignRecipientsOptions = {},
): Promise<CampaignRecipient[]> {
  const now = options.now ?? Date.now();
  const leaseTtlMs = options.leaseTtlMs ?? CAMPAIGN_DISPATCH_DEFAULT_LEASE_TTL_MS;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 20, CAMPAIGN_DISPATCH_MAX_BATCH));
  const recipientsCol = sub(establishmentId, "campaignRecipients");
  const campaignRef = sub(establishmentId, "campaigns").doc(campaignId);
  const overFetch = batchSize * 4;

  const claimed: CampaignRecipient[] = [];

  const claimFreshTx = async (docId: string) => {
    const ref = recipientsCol.doc(docId);
    return db.runTransaction(async (tx) => {
      const campaignSnap = await tx.get(campaignRef);
      if (!campaignSnap.exists || (campaignSnap.data() as Campaign).status !== "running") return null;
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const recipient = snap.data() as CampaignRecipient;
      if (recipient.status !== "pending" && recipient.status !== "queued") return null;
      if (recipient.nextAttemptAt && recipient.nextAttemptAt > now) return null;

      const patch = {
        status: "leased" as const,
        leaseOwner: workerId,
        leaseExpiresAt: now + leaseTtlMs,
        leaseAttemptStarted: false,
        updatedAt: now,
      };
      tx.update(ref, patch);
      return { ...recipient, ...patch };
    });
  };

  // Passo 1: recuperar (ou finalizar como ambíguo) leases "leased" vencidos.
  const leasedSnap = await recipientsCol
    .where("campaignId", "==", campaignId)
    .where("status", "==", "leased")
    .limit(overFetch)
    .get();
  for (const doc of leasedSnap.docs) {
    if (claimed.length >= batchSize) break;
    const ref = recipientsCol.doc(doc.id);
    const result = await db.runTransaction(async (tx) => {
      const campaignSnap = await tx.get(campaignRef);
      if (!campaignSnap.exists || (campaignSnap.data() as Campaign).status !== "running") return null;
      const recipientSnap = await tx.get(ref);
      if (!recipientSnap.exists) return null;
      const recipient = recipientSnap.data() as CampaignRecipient;
      if (recipient.status !== "leased" || !recipient.leaseExpiresAt || recipient.leaseExpiresAt > now) return null;

      if (recipient.leaseAttemptStarted) {
        const campaignSnap = await tx.get(campaignRef);
        if (!campaignSnap.exists) return null;
        const campaign = campaignSnap.data() as Campaign;
        tx.update(ref, {
          status: "failed",
          ambiguous: true,
          failureReason: "lease_expired_after_send_attempt",
          failedAt: now,
          updatedAt: now,
        });
        tx.update(campaignRef, { counters: bumpCampaignCounters(campaign.counters, "failed"), updatedAt: now });
        return null; // finalizado como falha; não entra no lote reclamado
      }

      const patch = {
        status: "leased" as const,
        leaseOwner: workerId,
        leaseExpiresAt: now + leaseTtlMs,
        leaseAttemptStarted: false,
        updatedAt: now,
      };
      tx.update(ref, patch);
      return { ...recipient, ...patch };
    });
    if (result) claimed.push(result);
  }

  // Passo 2: reivindicar recipients ainda não tentados (pending) ou já
  // agendados para retry (queued, nextAttemptAt vencido). Duas queries de
  // igualdade em vez de um único `in` — mesma filosofia do resto do repo:
  // nenhum índice composto novo.
  for (const status of ["pending", "queued"] as const) {
    if (claimed.length >= batchSize) break;
    const snap = await recipientsCol
      .where("campaignId", "==", campaignId)
      .where("status", "==", status)
      .limit(overFetch)
      .get();
    for (const doc of snap.docs) {
      if (claimed.length >= batchSize) break;
      const result = await claimFreshTx(doc.id);
      if (result) claimed.push(result);
    }
  }

  return claimed;
}

export type CampaignRecipientOutcome =
  | { kind: "sent"; metaMessageId?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string; ambiguous?: boolean }
  | { kind: "retry"; reason: string; nextAttemptAt: number };

export type ApplyCampaignRecipientOutcomeResult = "applied" | "stale_lease";

/**
 * Finaliza (ou reagenda) um recipient que ESTE worker tem em lease. Só
 * escreve se o documento ainda está `leased` por `workerId` — se outro
 * worker já reclamou ou finalizou (lease perdido/roubado), a chamada é um
 * no-op seguro (`"stale_lease"`), nunca sobrescreve o trabalho de outro
 * worker nem duplica os counters da campanha.
 */
export async function applyCampaignRecipientOutcome(
  establishmentId: string,
  campaignId: string,
  recipientId: string,
  workerId: string,
  outcome: CampaignRecipientOutcome,
  now = Date.now(),
): Promise<ApplyCampaignRecipientOutcomeResult> {
  const recipientRef = sub(establishmentId, "campaignRecipients").doc(recipientId);
  const campaignRef = sub(establishmentId, "campaigns").doc(campaignId);

  return db.runTransaction(async (tx) => {
    const recipientSnap = await tx.get(recipientRef);
    if (!recipientSnap.exists) return "stale_lease";
    const recipient = recipientSnap.data() as CampaignRecipient;
    if (recipient.status !== "leased" || recipient.leaseOwner !== workerId) return "stale_lease";

    if (outcome.kind === "retry") {
      tx.update(recipientRef, {
        status: "queued",
        nextAttemptAt: outcome.nextAttemptAt,
        failureReason: outcome.reason.slice(0, 300),
        updatedAt: now,
      });
      return "applied"; // ainda não é terminal: counters não avançam
    }

    const campaignSnap = await tx.get(campaignRef);
    if (!campaignSnap.exists) return "stale_lease";
    const campaign = campaignSnap.data() as Campaign;

    const bucket = outcome.kind;
    const patch: Record<string, unknown> = { status: bucket, updatedAt: now };
    if (outcome.kind === "sent") {
      patch.sentAt = now;
      if (outcome.metaMessageId) patch.metaMessageId = outcome.metaMessageId;
    } else {
      patch.failureReason = outcome.reason.slice(0, 300);
      if (outcome.kind === "failed") {
        patch.failedAt = now;
        if (outcome.ambiguous) patch.ambiguous = true;
      }
    }
    tx.update(recipientRef, patch);
    tx.update(campaignRef, { counters: bumpCampaignCounters(campaign.counters, bucket), updatedAt: now });
    return "applied";
  });
}

/**
 * Registra o INÍCIO da tentativa de envio (attempts++, leaseAttemptStarted
 * = true) ANTES de chamar a Graph API. É esta escrita que permite ao claim
 * distinguir, depois de um crash, "nunca cheguei a chamar a Meta" (lease
 * reclamável) de "cheguei a chamar, não sei se ela recebeu" (ambíguo,
 * finalizado sem retry automático). Só aplica se o lease ainda for deste
 * worker.
 */
export async function recordCampaignRecipientAttemptStart(
  establishmentId: string,
  recipientId: string,
  workerId: string,
  now = Date.now(),
): Promise<boolean> {
  const ref = sub(establishmentId, "campaignRecipients").doc(recipientId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const recipient = snap.data() as CampaignRecipient;
    if (recipient.status !== "leased" || recipient.leaseOwner !== workerId) return false;
    tx.update(ref, {
      attempts: (recipient.attempts ?? 0) + 1,
      lastAttemptAt: now,
      leaseAttemptStarted: true,
      updatedAt: now,
    });
    return true;
  });
}

// ---- Status Meta + Replies (CAMPANHAS-07) ----
// Fecha a observabilidade do dispatcher usando o MESMO webhook do WhatsApp
// (nenhum webhook novo): status de entrega (sent/delivered/read/failed)
// correlacionado por metaMessageId, e resposta do cliente correlacionada por
// telefone dentro de uma janela determinística. Estratégia completa
// documentada em docs/CAMPANHAS.md, seção "Status Meta + Replies".

export type CampaignDeliveryStatus = "sent" | "delivered" | "read" | "failed";
export type ApplyCampaignDeliveryStatusResult = "applied" | "not_found" | "no_change";

// Progressão só nesta direção — nunca regride (evento atrasado/duplicado é
// no-op). "failed" pós-envio só se aplica a partir de "sent" puro: uma vez
// delivered/read, a Meta não teria motivo real para reportar failed depois,
// e mesmo que reportasse, preferimos preservar o estado mais avançado.
const DELIVERY_STATUS_RANK: Partial<Record<CampaignRecipientStatus, number>> = {
  sent: 1,
  delivered: 2,
  read: 3,
};

function sanitizeMetaStatusError(error?: { code?: number; title?: string }): string {
  if (!error) return "delivery_failed";
  const parts = [`code=${error.code ?? "?"}`];
  if (error.title) parts.push(error.title.slice(0, 120));
  return parts.join(" ").slice(0, 300);
}

/**
 * Correlaciona um status callback da Meta (sent/delivered/read/failed) ao
 * CampaignRecipient dono do `metaMessageId`, dentro do tenant já resolvido
 * pelo chamador (nunca aceita establishmentId do corpo do webhook).
 *
 * `sent`→`delivered`→`read` é um funil aditivo nos counters (ver
 * docs/CAMPANHAS.md): "read" sem um "delivered" prévio credita os DOIS
 * counters de uma vez, porque ler implica ter sido entregue. `counters.sent`
 * nunca é decrementado aqui — já foi incrementado pelo dispatcher ao
 * despachar; um "failed" pós-envio (Meta aceitou mas não entregou) soma em
 * `counters.failed` sem subtrair de `sent`, porque o envio de fato aconteceu.
 */
export async function applyCampaignDeliveryStatus(
  establishmentId: string,
  metaMessageId: string,
  status: CampaignDeliveryStatus,
  error?: { code?: number; title?: string },
  now = Date.now(),
): Promise<ApplyCampaignDeliveryStatusResult> {
  const snap = await sub(establishmentId, "campaignRecipients").where("metaMessageId", "==", metaMessageId).limit(1).get();
  if (snap.empty) return "not_found";
  const recipientRef = sub(establishmentId, "campaignRecipients").doc(snap.docs[0]!.id);

  return db.runTransaction(async (tx) => {
    const recipientSnap = await tx.get(recipientRef);
    if (!recipientSnap.exists) return "not_found";
    const recipient = recipientSnap.data() as CampaignRecipient;
    const currentRank = DELIVERY_STATUS_RANK[recipient.status] ?? 0;
    // Não é sent/delivered/read (ex.: já replied, failed, skipped, ou nunca
    // chegou a ser enviado): nunca regride um estado terminal/anterior.
    if (currentRank === 0) return "no_change";

    const campaignRef = sub(establishmentId, "campaigns").doc(recipient.campaignId);

    if (status === "failed") {
      if (recipient.status !== "sent") return "no_change";
      const campaignSnap = await tx.get(campaignRef);
      if (!campaignSnap.exists) return "no_change";
      const campaign = campaignSnap.data() as Campaign;
      tx.update(recipientRef, {
        status: "failed",
        failedAt: now,
        failureReason: sanitizeMetaStatusError(error),
        updatedAt: now,
      });
      tx.update(campaignRef, {
        counters: { ...campaign.counters, failed: campaign.counters.failed + 1 },
        updatedAt: now,
      });
      return "applied";
    }

    const newRank = DELIVERY_STATUS_RANK[status] ?? 0;
    if (newRank <= currentRank) return "no_change";

    const campaignSnap = await tx.get(campaignRef);
    if (!campaignSnap.exists) return "no_change";
    let counters = (campaignSnap.data() as Campaign).counters;
    const patch: Record<string, unknown> = { status, updatedAt: now };
    if (newRank >= 2 && currentRank < 2) {
      counters = { ...counters, delivered: counters.delivered + 1 };
      patch.deliveredAt = now;
    }
    if (newRank >= 3 && currentRank < 3) {
      counters = { ...counters, read: counters.read + 1 };
      patch.readAt = now;
    }
    tx.update(recipientRef, patch);
    tx.update(campaignRef, { counters, updatedAt: now });
    return "applied";
  });
}

export type CorrelateCampaignReplyResult = "applied" | "already_replied" | "no_match";

const REPLY_CORRELATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

/**
 * Quando o cliente responde, procura o CampaignRecipient mais recente e
 * elegível (status sent/delivered/read, `sentAt` dentro da janela de 7 dias)
 * para aquele telefone NESTE tenant e marca `replied` uma única vez. Nunca
 * atribui uma resposta a uma campanha fora da janela, e se houver mais de
 * um candidato, o mais recente por `sentAt` vence (critério determinístico;
 * `id` como desempate estável). Não altera Conversation/CustomerProfile —
 * quem chama continua o fluxo normal da Lívia independentemente do
 * resultado aqui.
 */
export async function correlateCampaignReply(
  establishmentId: string,
  customerPhone: string,
  now = Date.now(),
): Promise<CorrelateCampaignReplyResult> {
  const phone = normalizePhone(customerPhone);
  const snap = await sub(establishmentId, "campaignRecipients").where("customerPhone", "==", phone).limit(50).get();

  // Inclui "replied" na seleção (não só sent/delivered/read): se o candidato
  // mais recente já foi respondido antes, o resultado precisa ser
  // "already_replied" — nunca cair silenciosamente para uma campanha mais
  // antiga só porque a mais recente já está resolvida.
  const candidates = snap.docs
    .map((doc) => doc.data() as CampaignRecipient)
    .filter(
      (r) =>
        (r.status === "sent" || r.status === "delivered" || r.status === "read" || r.status === "replied") &&
        typeof r.sentAt === "number" &&
        now - r.sentAt <= REPLY_CORRELATION_WINDOW_MS,
    )
    .sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0) || b.id.localeCompare(a.id));

  if (candidates.length === 0) return "no_match";
  const chosen = candidates[0]!;

  const recipientRef = sub(establishmentId, "campaignRecipients").doc(chosen.id);
  const campaignRef = sub(establishmentId, "campaigns").doc(chosen.campaignId);

  return db.runTransaction(async (tx) => {
    const recipientSnap = await tx.get(recipientRef);
    if (!recipientSnap.exists) return "no_match";
    const recipient = recipientSnap.data() as CampaignRecipient;
    if (recipient.status === "replied") return "already_replied";
    if (recipient.status !== "sent" && recipient.status !== "delivered" && recipient.status !== "read") return "no_match";

    const campaignSnap = await tx.get(campaignRef);
    if (!campaignSnap.exists) return "no_match";
    const campaign = campaignSnap.data() as Campaign;

    tx.update(recipientRef, { status: "replied", repliedAt: now, updatedAt: now });
    tx.update(campaignRef, { counters: { ...campaign.counters, replied: campaign.counters.replied + 1 }, updatedAt: now });
    return "applied";
  });
}

export type MarketingOptOutResult = "opted_out" | "already_opted_out" | "blocked" | "customer_not_found";

// Opt-out é uma operação terminal para marketing, mas não altera Conversation,
// CustomerProfile fora da política, agenda, handoff nem o atendimento normal.
// A transação torna a repetição idempotente e preserva o primeiro registro.
export async function optOutCustomerFromMarketing(
  establishmentId: string,
  phone: string,
  reason?: string,
): Promise<MarketingOptOutResult> {
  const ref = sub(establishmentId, "customers").doc(normalizePhone(phone));
  const normalizedReason = reason?.trim().slice(0, 160) || "customer_request";

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "customer_not_found";

    const profile = snap.data() as CustomerProfile;
    if (profile.marketingStatus === "blocked") return "blocked";
    if (profile.marketingStatus === "opted_out") return "already_opted_out";

    const now = Date.now();
    tx.update(ref, {
      marketingStatus: "opted_out",
      marketingStatusUpdatedAt: now,
      marketingOptOutAt: now,
      marketingOptOutReason: normalizedReason,
      updatedAt: now,
    });
    return "opted_out";
  });
}

const MAX_MARKETING_IMPORT_CONTACTS = 200;

type NormalizedImportContact = { phone: string; name: string | null };

function normalizeMarketingImport(
  contacts: readonly MarketingImportContact[],
): { contacts: NormalizedImportContact[]; duplicates: number } {
  if (!Array.isArray(contacts) || contacts.length === 0 || contacts.length > MAX_MARKETING_IMPORT_CONTACTS) {
    throw new Error(`Importação deve conter entre 1 e ${MAX_MARKETING_IMPORT_CONTACTS} contatos.`);
  }

  const unique = new Map<string, NormalizedImportContact>();
  for (const contact of contacts) {
    const phone = normalizeMarketingImportPhone(contact?.phone);
    if (!phone) throw new Error("Telefone de importação inválido.");
    if (contact.name !== undefined && typeof contact.name !== "string") {
      throw new Error("Nome de importação inválido.");
    }
    const name = contact.name?.trim().slice(0, 160) || null;
    const prior = unique.get(phone);
    // Duplicatas não criam outro perfil; aproveita um nome presente sem nunca
    // permitir que a repetição sobrescreva um nome já escolhido antes.
    if (!prior || (!prior.name && name)) unique.set(phone, { phone, name });
  }

  return { contacts: [...unique.values()], duplicates: contacts.length - unique.size };
}

// Importa/enriquece a coleção customers do próprio tenant. A declaração
// explícita do estabelecimento é obrigatória: `crm_import` identifica a
// origem operacional, mas não substitui `confirmedMarketingOptIn: true`.
// O lote é deliberadamente limitado; bases grandes precisam de uma etapa
// assíncrona própria, nunca de uma request longa e parcialmente executada.
export async function importMarketingContacts(
  establishmentId: string,
  input: { contacts: readonly MarketingImportContact[]; declaration: MarketingImportDeclaration },
): Promise<MarketingImportResult> {
  if (input.declaration?.confirmedMarketingOptIn !== true || !isMarketingOptInSource(input.declaration?.source)) {
    throw new Error("Declaração explícita de opt-in é obrigatória.");
  }
  const normalized = normalizeMarketingImport(input.contacts);
  const result: MarketingImportResult = {
    received: input.contacts.length,
    unique: normalized.contacts.length,
    duplicates: normalized.duplicates,
    created: 0,
    enriched: 0,
    eligible: 0,
    alreadyEligible: 0,
    protected: 0,
  };

  for (const contact of normalized.contacts) {
    const outcome = await db.runTransaction(async (tx) => {
      const ref = sub(establishmentId, "customers").doc(contact.phone);
      const snap = await tx.get(ref);
      const now = Date.now();

      if (!snap.exists) {
        const profile: CustomerProfile = {
          phone: contact.phone,
          establishmentId,
          name: contact.name,
          preferredProfessional: null,
          preferredTime: null,
          frequentAddress: null,
          lastService: null,
          lastIntent: null,
          notes: null,
          marketingStatus: "eligible",
          marketingStatusUpdatedAt: now,
          marketingOptInAt: now,
          marketingOptInSource: input.declaration.source,
          marketingOptInDeclarationAt: now,
          marketingOptInDeclarationVersion: "whatsapp_marketing_consent_v1",
          // Perfil importado ainda não conversou; createdAt é o melhor valor
          // disponível para a ordenação existente até uma interação real.
          lastInteractionAt: now,
          createdAt: now,
          updatedAt: now,
        };
        tx.create(ref, profile);
        return "created_eligible" as const;
      }

      const profile = snap.data() as CustomerProfile;
      if (profile.marketingStatus === "opted_out" || profile.marketingStatus === "blocked") {
        return "protected" as const;
      }

      const patch: Record<string, unknown> = {};
      if (!profile.name && contact.name) patch.name = contact.name;
      if (profile.marketingStatus === "eligible") {
        if (Object.keys(patch).length === 0) return "already_eligible" as const;
        patch.updatedAt = now;
        tx.update(ref, patch);
        return "enriched_eligible" as const;
      }

      patch.marketingStatus = "eligible";
      patch.marketingStatusUpdatedAt = now;
      patch.marketingOptInAt = now;
      patch.marketingOptInSource = input.declaration.source;
      patch.marketingOptInDeclarationAt = now;
      patch.marketingOptInDeclarationVersion = "whatsapp_marketing_consent_v1";
      patch.updatedAt = now;
      const enriched = Object.prototype.hasOwnProperty.call(patch, "name");
      tx.update(ref, patch);
      return enriched ? "eligible_enriched" as const : "eligible" as const;
    });

    if (outcome === "created_eligible") {
      result.created++;
      result.eligible++;
    } else if (outcome === "eligible") {
      result.eligible++;
    } else if (outcome === "eligible_enriched") {
      result.eligible++;
      result.enriched++;
    } else if (outcome === "enriched_eligible") {
      result.enriched++;
    } else if (outcome === "already_eligible") {
      result.alreadyEligible++;
    } else {
      result.protected++;
    }
  }

  return result;
}

// Recupera (ou cria) a conversa do contato e devolve as últimas mensagens
// pra dar contexto à IA.
export async function loadConversation(
  establishmentId: string,
  contactPhone: string,
  contactName: string | null,
  historyLimit = 12,
): Promise<{ conversation: Conversation; history: Message[] }> {
  const id = normalizePhone(contactPhone);
  const convRef = sub(establishmentId, "conversations").doc(id);
  const snap = await convRef.get();

  let conversation: Conversation;
  if (snap.exists) {
    conversation = snap.data() as Conversation;
  } else {
    conversation = {
      id,
      establishmentId,
      contactPhone: id,
      contactName,
      status: "bot",
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
    };
    await convRef.set(conversation);
  }

  const msgsSnap = await convRef
    .collection("messages")
    .orderBy("at", "desc")
    .limit(historyLimit)
    .get();
  const history = msgsSnap.docs
    .map((d) => d.data() as Message)
    .reverse(); // ordem cronológica

  return { conversation, history };
}

export async function appendMessage(
  establishmentId: string,
  conversationId: string,
  role: MessageRole,
  text: string,
  waMessageId?: string,
  metadata?: Pick<Message, "kind" | "phoneNumberId" | "media" | "attachment" | "transcription">,
): Promise<{ id: string; at: number }> {
  const convRef = sub(establishmentId, "conversations").doc(conversationId);
  const msgRef = convRef.collection("messages").doc();
  const msg: Message = {
    id: msgRef.id,
    role,
    text,
    at: Date.now(),
    ...(waMessageId ? { waMessageId } : {}),
    ...(metadata?.kind ? { kind: metadata.kind } : {}),
    ...(metadata?.phoneNumberId ? { phoneNumberId: metadata.phoneNumberId } : {}),
    ...(metadata?.media ? { media: metadata.media } : {}),
    ...(metadata?.attachment ? { attachment: metadata.attachment } : {}),
    ...(metadata?.transcription ? { transcription: metadata.transcription } : {}),
  };
  await msgRef.set(msg);
  await convRef.update({
    lastMessageAt: msg.at,
    ...(role === "customer" ? { lastCustomerMessageAt: msg.at } : {}),
  });
  return { id: msg.id, at: msg.at };
}

export async function setConversationStatus(
  establishmentId: string,
  conversationId: string,
  status: Conversation["status"],
): Promise<void> {
  await sub(establishmentId, "conversations")
    .doc(conversationId)
    .update({ status });
}

// Persiste apenas o contexto de uma OFERTA de atendimento humano. A mudança
// para `handoff` continua sendo uma decisão separada do webhook, depois de um
// pedido explícito ou de um aceite inequívoco do cliente.
export async function setAwaitingHumanOfferConfirmation(
  establishmentId: string,
  conversationId: string,
  awaiting: boolean,
): Promise<void> {
  await sub(establishmentId, "conversations")
    .doc(conversationId)
    .update({ awaitingHumanOfferConfirmation: awaiting });
}

// Fecha uma conversa por um motivo não concorrente (despedida social).
export async function closeConversation(
  establishmentId: string,
  conversationId: string,
  reason: NonNullable<Conversation["closedReason"]>,
): Promise<void> {
  await sub(establishmentId, "conversations")
    .doc(conversationId)
    .update({ status: "closed", closedReason: reason });
}

// Compara e fecha no mesmo commit do Firestore. Só quem muda bot -> closed
// recebe true e, portanto, ganha o direito de emitir a despedida final.
export async function tryCloseAutomatedConversation(
  establishmentId: string,
  conversationId: string,
): Promise<boolean> {
  const ref = sub(establishmentId, "conversations").doc(conversationId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;

    const conversation = snap.data() as Conversation;
    if (conversation.status !== "bot") return false;

    tx.update(ref, {
      status: "closed",
      closedReason: "automated_recipient",
      task: FieldValue.delete(),
    });
    return true;
  });
}

// Reabertura explícita limpa o motivo antigo para que a conversa volte ao
// ciclo normal sem parecer bloqueada em leituras futuras.
export async function reopenConversation(
  establishmentId: string,
  conversationId: string,
): Promise<void> {
  await sub(establishmentId, "conversations")
    .doc(conversationId)
    .update({ status: "bot", closedReason: FieldValue.delete() });
}

// Grava a intenção detectada (determinística, ver lib/ai/intent.ts) na
// mensagem mais recente da conversa. Não é uma escrita "importante" o
// suficiente para uma transação — perder uma atualização por corrida rara
// aqui não tem efeito prático (a próxima mensagem já sobrescreve).
export async function setConversationIntent(
  establishmentId: string,
  conversationId: string,
  intent: IntentType,
): Promise<void> {
  const patch: Record<string, unknown> = { lastIntent: intent };
  // Carimba a evidência DURÁVEL de intenção de agendamento. `lastIntent`
  // sozinho é sobrescrito pela mensagem seguinte (ex.: o cliente responde só
  // "Avaliação" quando a Livia pergunta o serviço) — e sem este carimbo o
  // funil perdia a conversa inteira. Nunca é limpo por uma intenção
  // posterior diferente.
  if (intent === "schedule_appointment" || intent === "reschedule_appointment") {
    patch.lastScheduleIntentAt = Date.now();
  }
  await sub(establishmentId, "conversations").doc(conversationId).update(patch);
}

// Estado da tarefa em andamento (Fase 4) — `task: null` limpa o campo
// (tarefa concluída ou nunca iniciada).
export async function setConversationTask(
  establishmentId: string,
  conversationId: string,
  task: ConversationTask | null,
): Promise<void> {
  await sub(establishmentId, "conversations")
    .doc(conversationId)
    .update({ task: task ?? FieldValue.delete() });
}

// Resumo estruturado (Fase 2) — só chamado nos gatilhos definidos (handoff,
// agendamento concluído), nunca por mensagem.
export async function setConversationSummary(
  establishmentId: string,
  conversationId: string,
  summary: string,
): Promise<void> {
  await sub(establishmentId, "conversations")
    .doc(conversationId)
    .update({ summary, summaryUpdatedAt: Date.now() });
}

// Lista as conversas do estabelecimento pra tela /painel/conversas — mais
// recentes primeiro. `sub(establishmentId, ...)` já restringe à subcoleção
// do tenant, então não há risco de vazar conversa de outro estabelecimento.
export async function listConversations(
  establishmentId: string,
  limitCount = 50,
): Promise<Conversation[]> {
  const snap = await sub(establishmentId, "conversations")
    .orderBy("lastMessageAt", "desc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as Conversation);
}

// Conversas com atividade desde `since` — usado pelo painel diário (Passo
// 13) e pela caixa de entrada. Range de campo único (lastMessageAt), sem
// combinar com outra igualdade na query: não precisa de índice composto. O
// filtro por lastIntent/status para métricas específicas é feito em memória
// por quem chama — mesmo padrão já usado em findEstablishmentByPhoneNumberId
// (c7982fd), deliberado pelo mesmo motivo (uma query que falha por índice
// faltante aqui derrubaria o painel inteiro, não só uma mensagem).
export async function listConversationsSince(
  establishmentId: string,
  since: number,
  limitCount = 500,
): Promise<Conversation[]> {
  const snap = await sub(establishmentId, "conversations")
    .where("lastMessageAt", ">=", since)
    .orderBy("lastMessageAt", "desc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as Conversation);
}

export async function getConversation(
  establishmentId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const doc = await sub(establishmentId, "conversations").doc(conversationId).get();
  return doc.exists ? (doc.data() as Conversation) : null;
}

// Mensagens de uma conversa em ordem cronológica, pra exibir na tela (não
// confundir com o histórico deslizante usado pela IA em loadConversation).
export async function listMessages(
  establishmentId: string,
  conversationId: string,
  limitCount = 100,
): Promise<Message[]> {
  const snap = await sub(establishmentId, "conversations")
    .doc(conversationId)
    .collection("messages")
    .orderBy("at", "desc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as Message).reverse();
}

export async function getMessage(
  establishmentId: string,
  conversationId: string,
  messageId: string,
): Promise<Message | null> {
  const doc = await sub(establishmentId, "conversations")
    .doc(conversationId)
    .collection("messages")
    .doc(messageId)
    .get();
  return doc.exists ? (doc.data() as Message) : null;
}

// Apaga TODAS as conversas (e suas mensagens) de UM estabelecimento — usado
// pela ferramenta de limpeza em /painel/conversas (ex.: preparar o painel
// pra gravação de vídeo). NUNCA faz exclusão global de collection: `sub()`
// já escopa tudo à subcoleção establishments/{establishmentId}/conversations,
// que é fisicamente separada da de qualquer outro tenant no Firestore — não
// há como isso vazar para outro estabelecimento. Não toca em appointments,
// meta/knowledge, schedule, whatsapp ou no doc do estabelecimento em si;
// só conversas + suas mensagens.
export async function clearConversations(
  establishmentId: string,
): Promise<{ deletedConversations: number; deletedMessages: number }> {
  const convsSnap = await sub(establishmentId, "conversations").get();

  let deletedConversations = 0;
  let deletedMessages = 0;

  for (const convDoc of convsSnap.docs) {
    const msgsSnap = await convDoc.ref.collection("messages").get();
    // Firestore aceita no máx. 500 operações por batch — 450 dá margem.
    for (let i = 0; i < msgsSnap.docs.length; i += 450) {
      const chunk = msgsSnap.docs.slice(i, i + 450);
      const batch = db.batch();
      chunk.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deletedMessages += chunk.length;
    }
    await convDoc.ref.delete();
    deletedConversations++;
  }

  return { deletedConversations, deletedMessages };
}

// Dedupe: a Meta reenvia webhooks. Guardamos os IDs já processados por
// alguns minutos pra não responder duas vezes à mesma mensagem.
// Aquisição ATÔMICA do id da mensagem. O par get()+set() anterior não era
// atômico: a Meta reentrega rápido e o Vercel roda as invocações em
// paralelo, então as duas liam "não existe" e as duas processavam —
// resposta duplicada e, no pior caso, ferramenta de escrita executada duas
// vezes.
//
// `create()` falha com ALREADY_EXISTS (código gRPC 6) quando o documento já
// existe; a checagem e a escrita acontecem numa única operação no servidor,
// então duas chamadas concorrentes nunca adquirem o mesmo id.
//
// Falha DEPOIS da aquisição: o id permanece gravado e a reentrega da Meta é
// descartada. É de propósito — a mensagem já pode ter sido enviada ao
// cliente antes do erro, e liberar a trava reprocessaria (resposta dobrada,
// possível agendamento duplicado). Mantém o mesmo comportamento de antes
// desta correção (at-most-once) em vez de trocá-lo por um pior.
export async function alreadyProcessed(waMessageId: string): Promise<boolean> {
  const ref = db.collection("_processed_wa_messages").doc(waMessageId);
  try {
    await ref.create({ at: Date.now() });
    return false; // adquirido agora por ESTA execução
  } catch (err) {
    if (isAlreadyExists(err)) return true; // outra execução já adquiriu
    throw err; // erro real de infraestrutura — não engolir
  }
}

// ALREADY_EXISTS do Firestore: código gRPC 6. Checa também a mensagem porque
// o emulador/algumas versões do SDK só trazem o texto.
function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.code === 6 || e.code === "already-exists") return true;
  return typeof e.message === "string" && e.message.includes("ALREADY_EXISTS");
}

export async function markDailyOwnerSummarySent(id: string, localDate: string): Promise<void> {
  await establishmentRef(id).update({ "dailyOwnerSummary.lastSentDate": localDate });
}
