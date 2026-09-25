import { db, sub } from "@/lib/firebase/admin";
import { templateParameterIndexes } from "@/lib/campaignTemplates";
import { getOrder, getOrderSettings } from "@/lib/orders";
import { appendMessage, getEstablishment } from "@/lib/repo";
import { orderNumber } from "@/lib/orderNotificationPolicy";
import { listMessageTemplates, normalizePhone, sendTemplate, sendText } from "@/lib/whatsapp/client";
import type { Message, OrderNotificationStatus, OrderStatusNotification } from "@/types";

export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

function notificationRef(establishmentId: string, notificationId: string) {
  return sub(establishmentId, "orderNotifications").doc(notificationId);
}

export async function getOrderStatusNotification(establishmentId: string, notificationId: string): Promise<OrderStatusNotification | null> {
  const snap = await notificationRef(establishmentId, notificationId).get();
  return snap.exists ? snap.data() as OrderStatusNotification : null;
}

export async function listOrderStatusNotifications(establishmentId: string, orderId: string): Promise<OrderStatusNotification[]> {
  const snap = await sub(establishmentId, "orderNotifications").where("orderId", "==", orderId).get();
  return snap.docs.map((doc) => doc.data() as OrderStatusNotification).sort((a, b) => a.createdAt - b.createdAt);
}

async function latestCustomerMessageAt(establishmentId: string, conversationId: string, expectedContactPhone: string): Promise<number | null> {
  const conversationRef = sub(establishmentId, "conversations").doc(conversationId);
  const conversation = await conversationRef.get();
  if (!conversation.exists) return null;
  const conversationData = conversation.data() as { contactPhone?: unknown; lastCustomerMessageAt?: unknown };
  if (typeof conversationData.contactPhone !== "string" || normalizePhone(conversationData.contactPhone) !== normalizePhone(expectedContactPhone)) return null;
  const persisted = Number(conversationData.lastCustomerMessageAt);
  if (Number.isFinite(persisted) && persisted > 0) return persisted;

  // Compatibilidade conservadora com conversas anteriores à F7. Lemos as
  // últimas mensagens e aceitamos somente um timestamp inbound persistido;
  // `lastMessageAt` não serve, pois também avança em respostas outbound.
  const messages = await conversationRef.collection("messages").orderBy("at", "desc").limit(200).get();
  const inbound = messages.docs.map((doc) => doc.data() as Message).find((message) => message.role === "customer");
  return inbound && Number.isFinite(inbound.at) ? inbound.at : null;
}

export function isCustomerServiceWindowOpen(lastCustomerMessageAt: number | null, now = Date.now()): boolean {
  // Exatamente 24h já é tratado como fechado. Timestamp futuro também não é
  // evidência válida: em qualquer dúvida temporal, não autorizamos texto livre.
  return lastCustomerMessageAt !== null && lastCustomerMessageAt > now - CUSTOMER_SERVICE_WINDOW_MS && lastCustomerMessageAt <= now;
}

async function claimNotification(establishmentId: string, notificationId: string): Promise<{ claimed: boolean; notification: OrderStatusNotification | null }> {
  const ref = notificationRef(establishmentId, notificationId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { claimed: false, notification: null };
    const current = snap.data() as OrderStatusNotification;
    if (current.status !== "pending") return { claimed: false, notification: current };
    const now = Date.now();
    const claimed: OrderStatusNotification = { ...current, status: "processing", attemptCount: current.attemptCount + 1, updatedAt: now };
    tx.set(ref, claimed);
    return { claimed: true, notification: claimed };
  });
}

async function finishNotification(
  establishmentId: string,
  notificationId: string,
  patch: Partial<OrderStatusNotification> & Pick<OrderStatusNotification, "status">,
): Promise<OrderStatusNotification | null> {
  const ref = notificationRef(establishmentId, notificationId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as OrderStatusNotification;
    if (current.status !== "processing") return current;
    const next = { ...current, ...patch, updatedAt: Date.now() } as OrderStatusNotification;
    tx.set(ref, next);
    return next;
  });
}

async function skipNotification(establishmentId: string, notificationId: string, errorCode: string) {
  const now = Date.now();
  return finishNotification(establishmentId, notificationId, { status: "skipped", errorCode, skippedAt: now });
}

/** Processa somente um evento já persistido pela transação do pedido.
 * A claim transacional ocorre antes de qualquer I/O externo e a Meta jamais
 * é chamada dentro de uma transaction Firestore. Estados processing/sent/
 * failed/skipped são terminais para retry automático: timeout ambíguo não
 * pode resultar em um segundo envio acidental. */
export async function dispatchOrderStatusNotification(establishmentId: string, notificationId: string): Promise<OrderStatusNotification | null> {
  const claim = await claimNotification(establishmentId, notificationId);
  if (!claim.claimed || !claim.notification) return claim.notification;
  const notification = claim.notification;

  const [order, establishment] = await Promise.all([
    getOrder(establishmentId, notification.orderId),
    getEstablishment(establishmentId),
  ]);
  if (!order || order.establishmentId !== establishmentId || !establishment) {
    return skipNotification(establishmentId, notificationId, "order_or_establishment_not_found");
  }
  if (order.mode === "demo") {
    return skipNotification(establishmentId, notificationId, "demo_order");
  }
  if (!establishment.whatsapp || establishment.whatsapp.status !== "connected") {
    return skipNotification(establishmentId, notificationId, "whatsapp_not_connected");
  }

  try {
    const inboundAt = await latestCustomerMessageAt(establishmentId, order.conversationId, order.contactPhone);
    let result: { waMessageId?: string };
    let sendType: "session" | "template";

    if (isCustomerServiceWindowOpen(inboundAt)) {
      sendType = "session";
      result = await sendText(establishment.whatsapp, establishmentId, order.contactPhone, notification.content);
    } else {
      const settings = await getOrderSettings(establishmentId);
      const configured = settings.notificationTemplates?.[notification.event];
      if (!configured) return skipNotification(establishmentId, notificationId, "template_not_configured");

      const templates = await listMessageTemplates(establishment.whatsapp, establishmentId);
      const template = templates.find((candidate) => candidate.name === configured.templateName && candidate.language === configured.languageCode);
      if (!template?.approved || !template.senderCompatible) {
        return skipNotification(establishmentId, notificationId, "template_not_approved_or_incompatible");
      }
      const indexes = templateParameterIndexes(template.components);
      if (indexes.length > 1 || (indexes.length === 1 && indexes[0] !== 1)) {
        return skipNotification(establishmentId, notificationId, "template_parameters_incompatible");
      }
      sendType = "template";
      result = await sendTemplate(
        establishment.whatsapp,
        establishmentId,
        order.contactPhone,
        configured.templateName,
        configured.languageCode,
        indexes.length === 1 ? [orderNumber(order.id)] : [],
      );
    }

    if (!result.waMessageId) {
      const now = Date.now();
      return finishNotification(establishmentId, notificationId, { status: "failed", errorCode: "meta_message_id_missing", failedAt: now });
    }
    const now = Date.now();
    const sent = await finishNotification(establishmentId, notificationId, {
      status: "sent",
      sendType,
      metaMessageId: result.waMessageId,
      sentAt: now,
    });
    if (sent) {
      await appendMessage(establishmentId, order.conversationId, "bot", notification.content, result.waMessageId).catch(() => undefined);
    }
    return sent;
  } catch {
    const now = Date.now();
    return finishNotification(establishmentId, notificationId, { status: "failed", errorCode: "whatsapp_send_failed", failedAt: now });
  }
}

const DELIVERY_RANK: Partial<Record<OrderNotificationStatus, number>> = { sent: 1, delivered: 2, read: 3 };

export async function applyOrderNotificationDeliveryStatus(
  establishmentId: string,
  metaMessageId: string,
  status: DeliveryStatus,
  error?: { code?: number; title?: string },
): Promise<"applied" | "no_match" | "no_change"> {
  const matches = await sub(establishmentId, "orderNotifications").where("metaMessageId", "==", metaMessageId).limit(1).get();
  const doc = matches.docs[0];
  if (!doc) return "no_match";
  const ref = notificationRef(establishmentId, doc.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "no_match" as const;
    const current = snap.data() as OrderStatusNotification;
    const now = Date.now();
    if (status === "failed") {
      if (current.status === "failed" || current.status === "read" || current.status === "delivered") return "no_change" as const;
      tx.set(ref, { ...current, status: "failed", errorCode: error?.code ? `meta_${error.code}` : "delivery_failed", failedAt: now, updatedAt: now });
      return "applied" as const;
    }
    const currentRank = DELIVERY_RANK[current.status] ?? 0;
    const nextRank = DELIVERY_RANK[status] ?? 0;
    if (nextRank <= currentRank || current.status === "failed" || current.status === "skipped") return "no_change" as const;
    tx.set(ref, {
      ...current,
      status,
      ...(status === "delivered" ? { deliveredAt: now } : {}),
      ...(status === "read" ? { deliveredAt: current.deliveredAt ?? now, readAt: now } : {}),
      updatedAt: now,
    });
    return "applied" as const;
  });
}
