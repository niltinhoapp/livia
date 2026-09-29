// Avisos ao responsável quando um cliente pede atendimento humano. São
// efeitos colaterais: nunca alteram status, posse ou pendência da conversa, e
// nenhuma falha (Meta, FCM, configuração ausente) desfaz o handoff.
import { db, sub } from "@/lib/firebase/admin";
import { sendTemplate } from "@/lib/whatsapp/client";
import { sendHandoffPush } from "@/lib/humanHandoff/push";
import {
  conversationPanelPath,
  customerLabel,
  handoffEpisodeId,
  HANDOFF_PUSH_REMINDER_INTERVAL_MS,
  templateParamsFor,
} from "@/lib/humanHandoff/policy";
import type { Conversation, Establishment, HandoffNotificationChannelResult, HandoffNotificationRecord } from "@/types";

type NotifiedConversation = Pick<Conversation, "id" | "contactName" | "contactPhone" | "handoffStartedAt" | "humanOwnership">;

function episodeRef(establishmentId: string, id: string) {
  return sub(establishmentId, "handoffNotifications").doc(id);
}

async function sendHandoffTemplate(establishment: Establishment, conversation: NotifiedConversation): Promise<HandoffNotificationChannelResult> {
  const config = establishment.humanHandoffNotifications!;
  const at = Date.now();
  if (!config.responsiblePhone || !config.templateName) return { status: "skipped", reason: "not_configured", at };
  if (establishment.whatsapp?.status !== "connected") return { status: "skipped", reason: "whatsapp_not_connected", at };
  try {
    const sent = await sendTemplate(
      establishment.whatsapp,
      establishment.id,
      config.responsiblePhone,
      config.templateName,
      config.templateLang || "pt_BR",
      templateParamsFor(config, conversation, process.env.APP_BASE_URL),
    );
    return { status: "sent", at, ...(sent.waMessageId ? { waMessageId: sent.waMessageId } : {}) };
  } catch (error) {
    // Mensagem do erro da Meta pode conter o telefone: só o nome da classe sai.
    return { status: "failed", reason: error instanceof Error ? error.name : "template_failed", at };
  }
}

/**
 * Handoff acabou de ser confirmado (quem venceu a transição bot → handoff).
 * O episódio é criado com `create`: um segundo chamador para o mesmo
 * episódio (retry, webhook duplicado) não envia nada.
 */
export async function notifyHandoffConfirmed(
  establishment: Establishment,
  conversation: NotifiedConversation,
  now = Date.now(),
): Promise<HandoffNotificationRecord | null> {
  const config = establishment.humanHandoffNotifications;
  const id = handoffEpisodeId(conversation);
  if (!config || !id || !conversation.handoffStartedAt) return null;
  const ref = episodeRef(establishment.id, id);
  const record: HandoffNotificationRecord = {
    id,
    conversationId: conversation.id,
    handoffStartedAt: conversation.handoffStartedAt,
    createdAt: now,
    lastPushAt: config.push ? now : null,
    pushReminders: 0,
    push: config.push ? { status: "pending" } : { status: "skipped", reason: "disabled" },
    whatsapp: config.whatsapp ? { status: "pending" } : { status: "skipped", reason: "disabled" },
  };
  const claimed = await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return false;
    tx.create(ref, record);
    return true;
  });
  if (!claimed) return null;

  const [push, whatsapp] = await Promise.all([
    config.push
      ? sendHandoffPush(establishment.id, {
          title: `${customerLabel(conversation)} pediu atendimento humano`,
          body: "Toque para abrir a conversa e assumir o atendimento.",
          url: conversationPanelPath(conversation.id),
          tag: `handoff-${conversation.id}`,
        })
      : Promise.resolve(record.push),
    config.whatsapp ? sendHandoffTemplate(establishment, conversation) : Promise.resolve(record.whatsapp),
  ]);
  await ref.update({ push, whatsapp });
  return { ...record, push, whatsapp };
}

/**
 * Cliente escreveu de novo enquanto o atendimento está pendente ou com um
 * humano. Só push, no máximo um por intervalo e por episódio; o template
 * nunca é reenviado. Reserva a janela antes de enviar (no máximo uma vez).
 */
export async function notifyHandoffActivity(
  establishment: Establishment,
  conversation: NotifiedConversation & Pick<Conversation, "status">,
  now = Date.now(),
): Promise<"sent" | "throttled" | "skipped"> {
  const config = establishment.humanHandoffNotifications;
  const id = handoffEpisodeId(conversation);
  if (!config?.push || !id) return "skipped";
  const ref = episodeRef(establishment.id, id);
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
        push: { status: "pending" },
        whatsapp: { status: "skipped", reason: "reminder" },
      } satisfies HandoffNotificationRecord);
      return true;
    }
    const current = snap.data() as HandoffNotificationRecord;
    if (current.lastPushAt !== null && now - current.lastPushAt < HANDOFF_PUSH_REMINDER_INTERVAL_MS) return false;
    tx.update(ref, { lastPushAt: now, pushReminders: (current.pushReminders ?? 0) + 1 });
    return true;
  });
  if (!reserved) return "throttled";
  const pending = conversation.status === "handoff";
  const push = await sendHandoffPush(establishment.id, {
    title: pending ? `${customerLabel(conversation)} ainda aguarda atendimento` : `Nova mensagem de ${customerLabel(conversation)}`,
    body: pending ? "O cliente escreveu de novo. Toque para assumir o atendimento." : "O cliente escreveu no atendimento que está com você.",
    url: conversationPanelPath(conversation.id),
    tag: `handoff-${conversation.id}`,
  });
  await ref.update({ push });
  return push.status === "sent" ? "sent" : "skipped";
}
