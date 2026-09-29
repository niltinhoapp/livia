// Avisos ao responsável quando um cliente pede atendimento humano. São
// efeitos colaterais: nunca alteram status, posse ou pendência da conversa, e
// nenhuma falha (Meta, FCM, configuração ausente) desfaz o handoff.
//
// Cada canal do episódio é uma pequena máquina de estados, reprocessável:
//   pending ──claim──▶ processing ──▶ sent | failed | skipped
//                         │ falha transitória ──▶ pending (backoff, tentativas limitadas)
//                         │ execução interrompida (claim velho):
//                         │   push     ──▶ pending (reenvio agrupado no aparelho)
//                         │   template ──▶ failed "outcome_unknown" (NUNCA reenvia)
// Reivindicar e concluir são transações; só o dono do claim conclui.
import { randomUUID } from "node:crypto";
import { db, sub } from "@/lib/firebase/admin";
import { sendTemplate } from "@/lib/whatsapp/client";
import { classifySendError } from "@/lib/campaignDispatcher";
import { sendHandoffPush, type PushOutcome } from "@/lib/humanHandoff/push";
import {
  conversationPanelPath,
  customerLabel,
  handoffEpisodeId,
  HANDOFF_PUSH_REMINDER_INTERVAL_MS,
  shouldNotifyHumanHandoff,
  templateParamsFor,
} from "@/lib/humanHandoff/policy";
import type { Conversation, Establishment, HandoffNotificationChannelResult, HandoffNotificationRecord } from "@/types";

type NotifiedConversation = Pick<Conversation, "id" | "contactName" | "contactPhone" | "handoffStartedAt" | "humanOwnership">;
type Channel = "push" | "whatsapp";

export const HANDOFF_DELIVERY = {
  maxAttempts: 5,
  // Uma execução que reivindicou um canal e não concluiu em 2 minutos caiu.
  staleClaimMs: 2 * 60 * 1000,
  backoffMs: (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 30 * 60_000),
  // A recuperação só cria episódio faltante para handoffs recentes: ligar o
  // aviso depois não dispara avisos de pendências antigas.
  missingEpisodeWindowMs: 24 * 60 * 60 * 1000,
} as const;

type SendOutcome =
  | { kind: "sent"; waMessageId?: string; delivered?: number }
  | { kind: "skipped"; reason: string }
  | { kind: "permanent"; reason: string }
  | { kind: "transient"; reason: string }
  // Não há como saber se a Meta aceitou (rede caiu no meio): nunca reenviar.
  | { kind: "unknown"; reason: string };

function episodeRef(establishmentId: string, id: string) {
  return sub(establishmentId, "handoffNotifications").doc(id);
}

const inFlight = (c: HandoffNotificationChannelResult) => c.status === "pending" || c.status === "processing";
const needsDelivery = (record: Pick<HandoffNotificationRecord, "push" | "whatsapp">) => inFlight(record.push) || inFlight(record.whatsapp);

async function sendHandoffTemplate(establishment: Establishment, conversation: NotifiedConversation): Promise<SendOutcome> {
  const config = establishment.humanHandoffNotifications;
  if (!config?.whatsapp) return { kind: "skipped", reason: "disabled" };
  if (!config.responsiblePhone || !config.templateName) return { kind: "skipped", reason: "not_configured" };
  if (establishment.whatsapp?.status !== "connected") return { kind: "skipped", reason: "whatsapp_not_connected" };
  try {
    const sent = await sendTemplate(
      establishment.whatsapp,
      establishment.id,
      config.responsiblePhone,
      config.templateName,
      config.templateLang || "pt_BR",
      templateParamsFor(config, conversation, process.env.APP_BASE_URL),
    );
    return { kind: "sent", ...(sent.waMessageId ? { waMessageId: sent.waMessageId } : {}) };
  } catch (error) {
    // Mesmo critério das campanhas: só uma resposta HTTP da Meta prova que o
    // envio NÃO aconteceu. Sem resposta, o resultado é desconhecido.
    const classified = classifySendError(error);
    if (classified.kind === "ambiguous") return { kind: "unknown", reason: "outcome_unknown" };
    if (classified.kind === "retryable" || classified.kind === "rate_limited") return { kind: "transient", reason: classified.reason };
    return { kind: "permanent", reason: classified.reason };
  }
}

function pushOutcome(result: PushOutcome): SendOutcome {
  return result.kind === "sent" ? { kind: "sent", delivered: result.delivered } : result;
}

function initialPush(conversation: NotifiedConversation) {
  return {
    title: `${customerLabel(conversation)} pediu atendimento humano`,
    body: "Toque para abrir a conversa e assumir o atendimento.",
    url: conversationPanelPath(conversation.id),
    tag: `handoff-${conversation.id}`,
  };
}

// Reivindica um canal para UMA execução. Retorna o claimId ou null se outra
// execução já o tem, se ainda não é hora de tentar ou se já terminou.
async function claimChannel(establishmentId: string, id: string, channel: Channel, now: number): Promise<string | null> {
  const ref = episodeRef(establishmentId, id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const record = snap.data() as HandoffNotificationRecord;
    const current = record[channel];
    let base = current;
    if (current.status === "processing") {
      if ((current.claimedAt ?? 0) > now - HANDOFF_DELIVERY.staleClaimMs) return null;
      if (channel === "whatsapp") {
        // Caiu durante o envio do template: pode ter chegado. Nunca duplica.
        const failed: HandoffNotificationChannelResult = { status: "failed", reason: "outcome_unknown", at: now, attempts: current.attempts };
        tx.update(ref, { whatsapp: failed, needsDelivery: needsDelivery({ ...record, whatsapp: failed }) });
        return null;
      }
      base = { ...current, status: "pending" };
    }
    if (base.status !== "pending" || (base.nextAttemptAt ?? 0) > now) return null;
    const claimId = randomUUID();
    const processing: HandoffNotificationChannelResult = { ...base, status: "processing", claimId, claimedAt: now, attempts: (base.attempts ?? 0) + 1 };
    tx.update(ref, { [channel]: processing, needsDelivery: true });
    return claimId;
  });
}

async function finishChannel(establishmentId: string, id: string, channel: Channel, claimId: string, outcome: SendOutcome, now: number): Promise<void> {
  const ref = episodeRef(establishmentId, id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const record = snap.data() as HandoffNotificationRecord;
    const current = record[channel];
    // Claim perdido (outra execução retomou): não sobrescreve o resultado dela.
    if (current.status !== "processing" || current.claimId !== claimId) return;
    const attempts = current.attempts ?? 1;
    let next: HandoffNotificationChannelResult;
    if (outcome.kind === "sent") {
      next = { status: "sent", at: now, attempts, ...(outcome.waMessageId ? { waMessageId: outcome.waMessageId } : {}), ...(outcome.delivered !== undefined ? { delivered: outcome.delivered } : {}) };
    } else if (outcome.kind === "skipped") {
      next = { status: "skipped", reason: outcome.reason, at: now, attempts };
    } else if (outcome.kind === "transient" && attempts < HANDOFF_DELIVERY.maxAttempts) {
      next = { status: "pending", reason: outcome.reason, at: now, attempts, nextAttemptAt: now + HANDOFF_DELIVERY.backoffMs(attempts) };
    } else {
      next = { status: "failed", reason: outcome.kind === "transient" ? `retries_exhausted:${outcome.reason}` : outcome.reason, at: now, attempts };
    }
    const updated = { ...record, [channel]: next };
    tx.update(ref, {
      [channel]: next,
      needsDelivery: needsDelivery(updated),
      ...(channel === "push" && next.status === "sent" ? { lastPushAt: now } : {}),
    });
  });
}

async function deliverChannel(establishment: Establishment, conversation: NotifiedConversation, id: string, channel: Channel, now: number): Promise<void> {
  const claimId = await claimChannel(establishment.id, id, channel, now);
  if (!claimId) return;
  const outcome = channel === "push"
    ? pushOutcome(await sendHandoffPush(establishment.id, initialPush(conversation)))
    : await sendHandoffTemplate(establishment, conversation);
  await finishChannel(establishment.id, id, channel, claimId, outcome, now);
}

/**
 * Entrega (ou retoma) o aviso inicial de um episódio. Idempotente: pode ser
 * chamado pela execução original, por retry, pela próxima mensagem do cliente
 * ou pela recuperação periódica — o claim transacional garante uma execução
 * por canal. Se a conversa já não está pendente, o que faltava é descartado.
 */
export async function deliverHandoffEpisode(establishment: Establishment, episodeId: string, now = Date.now()): Promise<HandoffNotificationRecord | null> {
  const ref = episodeRef(establishment.id, episodeId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const record = snap.data() as HandoffNotificationRecord;
  if (!needsDelivery(record)) return record;

  const conversationSnap = await sub(establishment.id, "conversations").doc(record.conversationId).get();
  const conversation = conversationSnap.exists ? (conversationSnap.data() as Conversation) : null;
  const stillPending = conversation?.status === "handoff" && conversation.handoffStartedAt === record.handoffStartedAt
    && shouldNotifyHumanHandoff(establishment, conversation.conversationContext);
  if (!conversation || !stillPending) {
    // Alguém já assumiu/devolveu (ou o aviso foi desligado): o aviso inicial
    // perdeu o propósito. Canais ainda não reivindicados são encerrados.
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) return;
      const current = fresh.data() as HandoffNotificationRecord;
      const close = (c: HandoffNotificationChannelResult): HandoffNotificationChannelResult =>
        c.status === "pending" ? { ...c, status: "skipped", reason: "no_longer_pending", at: now } : c;
      const updated = { ...current, push: close(current.push), whatsapp: close(current.whatsapp) };
      tx.update(ref, { push: updated.push, whatsapp: updated.whatsapp, needsDelivery: needsDelivery(updated) });
    });
    return (await ref.get()).data() as HandoffNotificationRecord;
  }

  await Promise.all([
    deliverChannel(establishment, conversation, episodeId, "push", now),
    deliverChannel(establishment, conversation, episodeId, "whatsapp", now),
  ]);
  return (await ref.get()).data() as HandoffNotificationRecord;
}

/**
 * Handoff acabou de ser confirmado. O episódio nasce com os canais em
 * `pending` (persistido ANTES de qualquer envio); a entrega vem logo depois
 * e, se esta execução cair, é retomada por quem chamar deliverHandoffEpisode.
 */
export async function notifyHandoffConfirmed(
  establishment: Establishment,
  conversation: NotifiedConversation,
  now = Date.now(),
): Promise<HandoffNotificationRecord | null> {
  const id = await ensureHandoffEpisode(establishment, conversation, now);
  if (!id) return null;
  return deliverHandoffEpisode(establishment, id, now);
}

async function ensureHandoffEpisode(establishment: Establishment, conversation: NotifiedConversation, now: number): Promise<string | null> {
  const config = establishment.humanHandoffNotifications;
  const id = handoffEpisodeId(conversation);
  if (!config || !id || !conversation.handoffStartedAt) return null;
  const record: HandoffNotificationRecord = {
    id,
    conversationId: conversation.id,
    handoffStartedAt: conversation.handoffStartedAt,
    createdAt: now,
    lastPushAt: null,
    pushReminders: 0,
    push: config.push ? { status: "pending", attempts: 0 } : { status: "skipped", reason: "disabled" },
    whatsapp: config.whatsapp ? { status: "pending", attempts: 0 } : { status: "skipped", reason: "disabled" },
  };
  record.needsDelivery = needsDelivery(record);
  const ref = episodeRef(establishment.id, id);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    tx.create(ref, record);
  });
  return id;
}

/**
 * Recuperação periódica (cron): retoma episódios interrompidos e cria o
 * episódio de um handoff recente que caiu antes de gravá-lo. Tentativas são
 * limitadas; falha permanente termina em `failed`, nunca em loop.
 */
export async function recoverHandoffNotifications(now = Date.now()): Promise<{ establishments: number; episodes: number }> {
  const snap = await db.collection("establishments").where("whatsapp.status", "==", "connected").get();
  let establishments = 0;
  let episodes = 0;
  for (const doc of snap.docs) {
    const establishment = doc.data() as Establishment;
    const config = establishment.humanHandoffNotifications;
    if (!config || (!config.push && !config.whatsapp)) continue;
    establishments++;
    try {
      const pending = await sub(establishment.id, "handoffNotifications").where("needsDelivery", "==", true).limit(20).get();
      for (const episode of pending.docs) {
        await deliverHandoffEpisode(establishment, episode.id, now);
        episodes++;
      }
      const handoffs = await sub(establishment.id, "conversations").where("status", "==", "handoff").limit(50).get();
      for (const conversationDoc of handoffs.docs) {
        const conversation = conversationDoc.data() as Conversation;
        const id = handoffEpisodeId(conversation);
        if (!id || !conversation.handoffStartedAt || conversation.handoffStartedAt < now - HANDOFF_DELIVERY.missingEpisodeWindowMs) continue;
        if (!shouldNotifyHumanHandoff(establishment, conversation.conversationContext)) continue;
        if ((await episodeRef(establishment.id, id).get()).exists) continue;
        await notifyHandoffConfirmed(establishment, conversation, now);
        episodes++;
      }
    } catch (error) {
      console.error("[human handoff] recuperação de avisos falhou", {
        estId: establishment.id,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return { establishments, episodes };
}

/**
 * Cliente escreveu de novo enquanto o atendimento está pendente ou com um
 * humano. Primeiro retoma um aviso inicial interrompido; depois, só push, no
 * máximo um por intervalo e por episódio. O template nunca é reenviado.
 */
export async function notifyHandoffActivity(
  establishment: Establishment,
  conversation: NotifiedConversation & Pick<Conversation, "status">,
  now = Date.now(),
): Promise<"sent" | "throttled" | "skipped"> {
  const config = establishment.humanHandoffNotifications;
  const id = handoffEpisodeId(conversation);
  if (!id) return "skipped";
  const ref = episodeRef(establishment.id, id);
  if ((await ref.get()).exists) await deliverHandoffEpisode(establishment, id, now);
  if (!config?.push) return "skipped";
  const reserved = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      // Atendimento assumido direto no painel (sem handoff): o episódio nasce
      // aqui, sem template — o responsável já está com a conversa.
      tx.create(ref, {
        id,
        conversationId: conversation.id,
        handoffStartedAt: conversation.handoffStartedAt ?? conversation.humanOwnership?.assumedAt ?? now,
        createdAt: now,
        lastPushAt: now,
        pushReminders: 1,
        needsDelivery: false,
        push: { status: "skipped", reason: "assumed_without_handoff" },
        whatsapp: { status: "skipped", reason: "assumed_without_handoff" },
      } satisfies HandoffNotificationRecord);
      return true;
    }
    const current = snap.data() as HandoffNotificationRecord;
    // Aviso inicial ainda em andamento: ele mesmo é o push desta janela.
    if (inFlight(current.push)) return false;
    if (current.lastPushAt !== null && now - current.lastPushAt < HANDOFF_PUSH_REMINDER_INTERVAL_MS) return false;
    tx.update(ref, { lastPushAt: now, pushReminders: (current.pushReminders ?? 0) + 1 });
    return true;
  });
  if (!reserved) return "throttled";
  const pending = conversation.status === "handoff";
  const result = await sendHandoffPush(establishment.id, {
    title: pending ? `${customerLabel(conversation)} ainda aguarda atendimento` : `Nova mensagem de ${customerLabel(conversation)}`,
    body: pending ? "O cliente escreveu de novo. Toque para assumir o atendimento." : "O cliente escreveu no atendimento que está com você.",
    url: conversationPanelPath(conversation.id),
    tag: `handoff-${conversation.id}`,
  });
  return result.kind === "sent" ? "sent" : "skipped";
}
