import { beforeEach, describe, expect, it, vi } from "vitest";

const sendText = vi.fn();
const sendTemplate = vi.fn();
const listMessageTemplates = vi.fn();
const getEstablishment = vi.fn();
const appendMessage = vi.fn();

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
vi.mock("@/lib/whatsapp/client", () => ({
  normalizePhone: (value: string) => value.replace(/\D/g, ""),
  sendText: (...args: unknown[]) => sendText(...args),
  sendTemplate: (...args: unknown[]) => sendTemplate(...args),
  listMessageTemplates: (...args: unknown[]) => listMessageTemplates(...args),
}));
vi.mock("@/lib/repo", () => ({
  getEstablishment: (...args: unknown[]) => getEstablishment(...args),
  appendMessage: (...args: unknown[]) => appendMessage(...args),
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { getOrder, transitionOrder } from "@/lib/orders";
import { orderNotificationId } from "@/lib/orderNotificationPolicy";
import {
  applyOrderNotificationDeliveryStatus,
  dispatchOrderStatusNotification,
  getOrderStatusNotification,
  isCustomerServiceWindowOpen,
  listOrderStatusNotifications,
} from "@/lib/orderNotifications";
import type { Establishment, FoodOrder, FoodOrderSnapshot, OrderStatus } from "@/types";

const NOW = Date.parse("2026-09-20T15:00:00.000Z");
const A = "est-a";
const B = "est-b";

function snapshot(fulfillment: "pickup" | "delivery"): FoodOrderSnapshot {
  return {
    items: [{ id: "item", productId: "product", productName: "X-Burguer", variantId: null, variantName: null, quantity: 1, unitPriceCents: 2000, modifiers: [], notes: null, lineTotalCents: 2000 }],
    subtotalCents: 2000, discountCents: 0, deliveryFeeCents: fulfillment === "delivery" ? 500 : 0,
    totalCents: fulfillment === "delivery" ? 2500 : 2000, fulfillment,
    deliveryAddress: fulfillment === "delivery" ? { raw: "Rua A, 1", neighborhood: "Centro", reference: null } : null,
    payment: { method: "pix", status: "pending", changeForCents: null }, createdAt: NOW - 1000,
  };
}

function order(id: string, status: OrderStatus, fulfillment: "pickup" | "delivery", establishmentId = A, version = 3): FoodOrder {
  const frozen = snapshot(fulfillment);
  return {
    id, establishmentId, conversationId: `conv-${id}`, contactPhone: "5511999990000", contactName: "Ana",
    status, fulfillment, deliveryAddress: frozen.deliveryAddress, deliveryFeeCents: frozen.deliveryFeeCents,
    discountCents: 0, payment: frozen.payment, items: frozen.items, subtotalCents: frozen.subtotalCents,
    totalCents: frozen.totalCents, version, confirmationRequestedAt: NOW - 2000, snapshot: frozen,
    operationalHistory: [{ from: "awaiting_confirmation", to: "confirmed", at: NOW - 2000, source: "customer_confirmation" }],
    createdAt: NOW - 5000, updatedAt: NOW - 2000, confirmedAt: NOW - 2000,
  };
}

function seedOrder(value: FoodOrder) {
  fakeDb.col(`establishments/${value.establishmentId}/orders`).set(value.id, value as unknown as Record<string, unknown>);
  fakeDb.col(`establishments/${value.establishmentId}/conversations`).set(value.conversationId, {
    id: value.conversationId, establishmentId: value.establishmentId, contactPhone: value.contactPhone, lastCustomerMessageAt: NOW - 60_000,
  });
}

function establishment(id = A): Establishment {
  return {
    id, name: "Lanchonete Teste", type: "lanchonete", ownerUid: "owner", status: "active", createdAt: 1,
    bot: { personaName: "Livia", tone: "", bookingEnabled: false, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
    whatsapp: { wabaId: `waba-${id}`, phoneNumberId: `phone-${id}`, status: "connected", accessToken: { ciphertext: "x", iv: "y", authTag: "z" } },
  };
}

function seedTemplates() {
  fakeDb.col(`establishments/${A}/meta`).set("orders", {
    pickupEnabled: true, deliveryEnabled: true, deliveryRules: [{ kind: "fixed", feeCents: 500 }],
    acceptedPaymentMethods: ["pix"], pixInstructions: null,
    notificationTemplates: { accepted: { templateName: "pedido_aceito", languageCode: "pt_BR" } },
  });
}

beforeEach(() => {
  fakeDb.reset();
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  getEstablishment.mockImplementation(async (id: string) => establishment(id));
  sendText.mockImplementation(async () => ({ waMessageId: "wamid.session" }));
  sendTemplate.mockResolvedValue({ waMessageId: "wamid.template" });
  listMessageTemplates.mockResolvedValue([{ id: "tpl", name: "pedido_aceito", language: "pt_BR", status: "APPROVED", approved: true, senderCompatible: true, components: [{ type: "BODY", text: "Pedido {{1}} aceito" }] }]);
  appendMessage.mockResolvedValue({ id: "message", at: NOW });
});

describe("matriz canônica de eventos", () => {
  it.each([
    ["accepted pickup", "confirmed", "accepted", "pickup", true],
    ["accepted delivery", "confirmed", "accepted", "delivery", true],
    ["preparing", "accepted", "preparing", "pickup", false],
    ["ready pickup", "preparing", "ready_for_pickup", "pickup", true],
    ["ready delivery", "preparing", "ready_for_pickup", "delivery", false],
    ["out delivery", "ready_for_pickup", "out_for_delivery", "delivery", true],
    ["completed pickup", "ready_for_pickup", "completed", "pickup", false],
    ["cancel pickup", "accepted", "cancelled", "pickup", true],
    ["cancel delivery", "accepted", "cancelled", "delivery", true],
  ] as const)("%s", async (_label, from, to, fulfillment, expected) => {
    const current = order(`order-${_label}`, from, fulfillment);
    seedOrder(current);
    const changed = await transitionOrder(A, current.id, to, current.version);
    const notifications = await listOrderStatusNotifications(A, current.id);
    expect(notifications).toHaveLength(expected ? 1 : 0);
    if (expected) expect(notifications[0]).toMatchObject({ event: to, orderVersion: changed.version, status: "pending", establishmentId: A });
  });

  it("retirada nunca cria out_for_delivery", async () => {
    const current = order("pickup-out", "ready_for_pickup", "pickup"); seedOrder(current);
    await expect(transitionOrder(A, current.id, "out_for_delivery", current.version)).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(listOrderStatusNotifications(A, current.id)).resolves.toEqual([]);
  });
});

describe("pedidos demonstrativos", () => {
  it("dispatcher ignora notificação persistida indevidamente para pedido demo", async () => {
    const demo = { ...order("demo", "confirmed", "pickup"), mode: "demo" as const, prospectingLeadId: "lead-demo" };
    seedOrder(demo);
    const id = orderNotificationId(demo.id, "accepted", demo.version + 1);
    fakeDb.col(`establishments/${A}/orderNotifications`).set(id, {
      id, establishmentId: A, orderId: demo.id, orderVersion: demo.version + 1,
      event: "accepted", orderStatus: "accepted", fulfillment: "pickup", status: "pending",
      sendType: null, attemptCount: 0, content: "Pedido demonstrativo", createdAt: NOW, updatedAt: NOW,
    });

    await expect(dispatchOrderStatusNotification(A, id)).resolves.toMatchObject({ status: "skipped", errorCode: "demo_order" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});

describe("envio, janela e templates", () => {
  it("dentro da janela usa texto de sessão determinístico e persiste wamid", async () => {
    const current = order("session123", "confirmed", "pickup"); seedOrder(current);
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const id = orderNotificationId(current.id, "accepted", changed.version);
    const notification = await dispatchOrderStatusNotification(A, id);
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: "phone-est-a" }), A, current.contactPhone, expect.stringContaining("#ION123"));
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(notification).toMatchObject({ status: "sent", sendType: "session", metaMessageId: "wamid.session" });
    expect(appendMessage).toHaveBeenCalledWith(A, current.conversationId, "bot", expect.stringContaining("pedido"), "wamid.session");
  });

  it("lastMessageAt outbound não abre janela; sem inbound/template faz skip seguro", async () => {
    const current = order("outside", "confirmed", "pickup"); seedOrder(current);
    fakeDb.col(`establishments/${A}/conversations`).set(current.conversationId, { id: current.conversationId, contactPhone: current.contactPhone, lastMessageAt: NOW });
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const result = await dispatchOrderStatusNotification(A, orderNotificationId(current.id, "accepted", changed.version));
    expect(result).toMatchObject({ status: "skipped", errorCode: "template_not_configured" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("fora da janela usa somente template configurado, aprovado e compatível", async () => {
    const current = order("template", "confirmed", "delivery"); seedOrder(current); seedTemplates();
    fakeDb.col(`establishments/${A}/conversations`).set(current.conversationId, { id: current.conversationId, contactPhone: current.contactPhone, lastCustomerMessageAt: NOW - 25 * 60 * 60 * 1000 });
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const result = await dispatchOrderStatusNotification(A, orderNotificationId(current.id, "accepted", changed.version));
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).toHaveBeenCalledWith(expect.anything(), A, current.contactPhone, "pedido_aceito", "pt_BR", ["#MPLATE"]);
    expect(result).toMatchObject({ status: "sent", sendType: "template", metaMessageId: "wamid.template" });
  });

  it("template ausente/não aprovado ou parâmetros incompatíveis nunca cai para texto livre", async () => {
    const current = order("bad-template", "confirmed", "pickup"); seedOrder(current); seedTemplates();
    fakeDb.col(`establishments/${A}/conversations`).set(current.conversationId, { id: current.conversationId, contactPhone: current.contactPhone, lastCustomerMessageAt: NOW - 25 * 60 * 60 * 1000 });
    listMessageTemplates.mockResolvedValueOnce([{ id: "tpl", name: "pedido_aceito", language: "pt_BR", approved: false, senderCompatible: true, components: [] }]);
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const result = await dispatchOrderStatusNotification(A, orderNotificationId(current.id, "accepted", changed.version));
    expect(result).toMatchObject({ status: "skipped", errorCode: "template_not_approved_or_incompatible" });
    expect(sendText).not.toHaveBeenCalled(); expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("determina a janela somente por inbound confiável", () => {
    expect(isCustomerServiceWindowOpen(NOW - 24 * 60 * 60 * 1000 + 1, NOW)).toBe(true);
    expect(isCustomerServiceWindowOpen(NOW - 24 * 60 * 60 * 1000, NOW)).toBe(false);
    expect(isCustomerServiceWindowOpen(NOW + 1, NOW)).toBe(false);
    expect(isCustomerServiceWindowOpen(null, NOW)).toBe(false);
  });

  it("inbound recente de outra identidade não abre a janela do telefone do pedido", async () => {
    const current = order("identity", "confirmed", "pickup"); seedOrder(current);
    fakeDb.col(`establishments/${A}/conversations`).set(current.conversationId, {
      id: current.conversationId, contactPhone: "5511888880000", lastCustomerMessageAt: NOW - 1000,
    });
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const result = await dispatchOrderStatusNotification(A, orderNotificationId(current.id, "accepted", changed.version));
    expect(result).toMatchObject({ status: "skipped", errorCode: "template_not_configured" });
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("idempotência, concorrência e falhas", () => {
  it("retry e duas execuções concorrentes enviam uma vez, sem duplicar evento ou histórico", async () => {
    const current = order("concurrent", "confirmed", "pickup"); seedOrder(current);
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const retried = await transitionOrder(A, current.id, "accepted", current.version);
    const id = orderNotificationId(current.id, "accepted", changed.version);
    const [first, second] = await Promise.all([dispatchOrderStatusNotification(A, id), dispatchOrderStatusNotification(A, id)]);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(first?.status === "sent" || second?.status === "sent").toBe(true);
    expect(await listOrderStatusNotifications(A, current.id)).toHaveLength(1);
    expect(retried.version).toBe(changed.version);
    expect((await getOrder(A, current.id))?.operationalHistory).toHaveLength(2);
  });

  it("falha Meta fica registrada e não reverte status; retry não reenvia", async () => {
    const current = order("meta-fail", "confirmed", "pickup"); seedOrder(current);
    sendText.mockRejectedValueOnce(new Error("network timeout"));
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const id = orderNotificationId(current.id, "accepted", changed.version);
    expect(await dispatchOrderStatusNotification(A, id)).toMatchObject({ status: "failed", errorCode: "whatsapp_send_failed" });
    await dispatchOrderStatusNotification(A, id);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await getOrder(A, current.id))?.status).toBe("accepted");
  });

  it("resposta inesperada sem wamid é terminal e nunca é declarada como enviada", async () => {
    const current = order("missing-wamid", "confirmed", "pickup"); seedOrder(current);
    sendText.mockResolvedValueOnce({});
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const id = orderNotificationId(current.id, "accepted", changed.version);
    expect(await dispatchOrderStatusNotification(A, id)).toMatchObject({ status: "failed", errorCode: "meta_message_id_missing" });
    await dispatchOrderStatusNotification(A, id);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(appendMessage).not.toHaveBeenCalled();
    expect((await getOrder(A, current.id))?.status).toBe("accepted");
  });

  it("sender externo nunca roda dentro da transaction Firestore", async () => {
    const current = order("outside-tx", "confirmed", "pickup"); seedOrder(current);
    sendText.mockImplementationOnce(async () => {
      expect(fakeDb.isTransactionActive()).toBe(false);
      return { waMessageId: "wamid.safe" };
    });
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    await dispatchOrderStatusNotification(A, orderNotificationId(current.id, "accepted", changed.version));
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("correlaciona sent/delivered/read/failed monotonicamente pelo wamid", async () => {
    const current = order("delivery-status", "confirmed", "pickup"); seedOrder(current);
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const id = orderNotificationId(current.id, "accepted", changed.version);
    await dispatchOrderStatusNotification(A, id);
    await expect(applyOrderNotificationDeliveryStatus(A, "wamid.session", "delivered")).resolves.toBe("applied");
    await expect(applyOrderNotificationDeliveryStatus(A, "wamid.session", "sent")).resolves.toBe("no_change");
    await expect(applyOrderNotificationDeliveryStatus(A, "wamid.session", "read")).resolves.toBe("applied");
    expect(await getOrderStatusNotification(A, id)).toMatchObject({ status: "read", deliveredAt: NOW, readAt: NOW });
  });
});

describe("isolamento multi-tenant", () => {
  it("evento e configuração de A não são visíveis nem processáveis por B", async () => {
    const current = order("private", "confirmed", "pickup", A); seedOrder(current);
    const changed = await transitionOrder(A, current.id, "accepted", current.version);
    const id = orderNotificationId(current.id, "accepted", changed.version);
    await expect(getOrderStatusNotification(B, id)).resolves.toBeNull();
    await expect(dispatchOrderStatusNotification(B, id)).resolves.toBeNull();
    expect(sendText).not.toHaveBeenCalled();
    expect(await dispatchOrderStatusNotification(A, id)).toMatchObject({ establishmentId: A, status: "sent" });
    await expect(applyOrderNotificationDeliveryStatus(B, "wamid.session", "delivered")).resolves.toBe("no_match");
  });
});
