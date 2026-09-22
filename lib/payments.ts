import { db, sub } from "@/lib/firebase/admin";
import type { FoodOrder, Payment, PaymentAttempt, PaymentAttemptStatus, PaymentChannel, PaymentEvent, PaymentEventType, PaymentMethod, PaymentProviderCapabilities, PaymentStatus } from "@/types";

const ATTEMPT_BLOCKED = new Set<PaymentStatus>(["paid", "failed", "cancelled", "expired", "refund_pending", "partially_refunded", "refunded", "disputed"]);
const orderRef = (establishmentId: string, orderId: string) => sub(establishmentId, "orders").doc(orderId);
const paymentRef = (establishmentId: string, paymentId: string) => sub(establishmentId, "payments").doc(paymentId);

export class PaymentDomainError extends Error { constructor(public readonly code: "order_not_confirmed" | "tenant_mismatch" | "invalid_transition" | "not_found" | "not_manual" | "stale_version" | "active_attempt", message = code) { super(message); this.name = "PaymentDomainError"; } }

export function manualMethodForOrder(method: FoodOrder["payment"]["method"]): PaymentMethod {
  if (method === "pix") return "manual_pix";
  if (method === "cash") return "cash";
  if (method === "credit_card") return "card_machine_credit";
  if (method === "debit_card") return "card_machine_debit";
  return "manual_other";
}

function paymentIdFor(orderId: string) { return `order_${orderId}`; }
function eventId(type: PaymentEventType, version: number) { return `${String(version).padStart(8, "0")}_${type}`; }
function event(payment: Payment, type: PaymentEventType, source: PaymentEvent["source"], previousStatus: PaymentStatus | null, actorUid: string | null, provider = payment.provider): PaymentEvent {
  return { id: eventId(type, payment.version), paymentId: payment.id, type, at: Date.now(), source, actorUid, previousStatus, nextStatus: payment.status, amountCents: payment.amountCents, provider, providerEventId: null };
}
export const PAYMENT_TRANSITIONS: Readonly<Partial<Record<PaymentStatus, readonly PaymentStatus[]>>> = {
    awaiting_customer: ["processing", "paid", "failed", "cancelled", "expired"], processing: ["authorized", "paid", "failed", "cancelled"], authorized: ["paid", "failed", "cancelled"], paid: ["refund_pending", "disputed"], refund_pending: ["paid", "partially_refunded", "refunded"], partially_refunded: ["refund_pending", "refunded"],
};

// A tentativa representa o ciclo do meio escolhido. Ela pode ser substituída
// somente antes de alcançar o processamento externo; após isso, somente a
// confirmação/cancelamento do próprio provedor poderá encerrá-la.
export const PAYMENT_ATTEMPT_TRANSITIONS: Readonly<Partial<Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]>>> = {
  awaiting_customer: ["processing", "paid", "failed", "cancelled", "expired", "superseded"],
  processing: ["authorized", "paid", "failed", "cancelled"],
  authorized: ["paid", "failed", "cancelled"],
};

function isMethodCompatibleWithChannel(channel: PaymentChannel, method: PaymentMethod) {
  return channel === "manual"
    ? ["manual_pix", "cash", "card_machine_credit", "card_machine_debit", "manual_other"].includes(method)
    : ["pix", "credit_card", "debit_card"].includes(method);
}

function assertTransition(from: PaymentStatus, to: PaymentStatus) {
  if (!PAYMENT_TRANSITIONS[from]?.includes(to)) throw new PaymentDomainError("invalid_transition");
}

function requireConfirmedOrder(order: FoodOrder, establishmentId: string) {
  if (order.establishmentId !== establishmentId) throw new PaymentDomainError("tenant_mismatch");
  // Snapshot confirmado continua válido após accepted/preparing/entrega e
  // completed. Cancelled/rejected não originam uma nova obrigação financeira.
  if (!new Set(["confirmed", "accepted", "preparing", "ready_for_pickup", "out_for_delivery", "completed"]).has(order.status) || !order.snapshot) throw new PaymentDomainError("order_not_confirmed");
}

export async function createPaymentForOrder(establishmentId: string, orderId: string): Promise<Payment> {
  const ref = paymentRef(establishmentId, paymentIdFor(orderId));
  const orderDocument = orderRef(establishmentId, orderId);
  return db.runTransaction(async (tx) => {
    const [orderSnap, existing] = await Promise.all([tx.get(orderDocument), tx.get(ref)]);
    if (!orderSnap.exists) throw new PaymentDomainError("not_found");
    const order = orderSnap.data() as FoodOrder;
    requireConfirmedOrder(order, establishmentId);
    if (existing.exists) return existing.data() as Payment;
    const now = Date.now(); const method = manualMethodForOrder(order.snapshot!.payment.method);
    const payment: Payment = { id: ref.id, establishmentId, orderId, orderVersion: order.version, amountCents: order.snapshot!.totalCents, currency: "BRL", status: "awaiting_customer", channel: "manual", method, provider: null, activeAttemptId: null, attemptCount: 0, paidAmountCents: 0, refundedAmountCents: 0, version: 1, createdAt: now, updatedAt: now, paidAt: null, cancelledAt: null };
    tx.create(ref, payment);
    tx.create(ref.collection("events").doc(eventId("payment_created", payment.version)), event(payment, "payment_created", "system", null, null));
    return payment;
  });
}

export async function createPaymentAttempt(establishmentId: string, paymentId: string, idempotencyKey: string, input?: { method?: PaymentMethod; channel?: PaymentChannel; provider?: string | null; expiresAt?: number | null }): Promise<PaymentAttempt> {
  const ref = paymentRef(establishmentId, paymentId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); if (!snap.exists) throw new PaymentDomainError("not_found"); const current = snap.data() as Payment;
    const attempts = ref.collection("attempts"); const existing = await tx.get(attempts.doc(idempotencyKey));
    if (existing.exists) return existing.data() as PaymentAttempt;
    if (ATTEMPT_BLOCKED.has(current.status) || current.status === "processing" || current.status === "authorized") throw new PaymentDomainError("invalid_transition");
    const channel = input?.channel ?? current.channel; const method = input?.method ?? current.method; const provider = channel === "provider" ? (input?.provider ?? null) : null;
    if ((channel === "provider" && !provider) || !isMethodCompatibleWithChannel(channel, method)) throw new PaymentDomainError("invalid_transition");
    if (current.activeAttemptId) {
      const previousRef = attempts.doc(current.activeAttemptId); const previousSnap = await tx.get(previousRef);
      if (!previousSnap.exists) throw new PaymentDomainError("active_attempt");
      const previous = previousSnap.data() as PaymentAttempt;
      if (previous.status === "awaiting_customer") {
        // A troca só é possível enquanto a tentativa anterior não alcançou o
        // provider em processamento/autorização; ela fica auditavelmente
        // superseded na mesma transação antes da nova ficar ativa.
        tx.update(previousRef, { status: "superseded", updatedAt: Date.now() });
      } else if (!["failed", "cancelled", "expired", "superseded"].includes(previous.status)) {
        throw new PaymentDomainError("active_attempt");
      }
    }
    const ordinal = current.attemptCount + 1; const now = Date.now(); const attempt: PaymentAttempt = { id: idempotencyKey, paymentId, ordinal, idempotencyKey, channel, method, provider, providerPaymentId: null, status: "awaiting_customer", amountCents: current.amountCents, createdAt: now, updatedAt: now, expiresAt: input?.expiresAt ?? null };
    const next: Payment = { ...current, channel, method, provider, activeAttemptId: attempt.id, attemptCount: ordinal, version: current.version + 1, updatedAt: now };
    tx.create(attempts.doc(attempt.id), attempt); tx.update(ref, next as unknown as Record<string, unknown>); tx.create(ref.collection("events").doc(eventId("attempt_created", next.version)), event(next, "attempt_created", "system", current.status, null, provider)); return attempt;
  });
}

export async function recordManualPayment(establishmentId: string, paymentId: string, expectedVersion: number, confirmationId: string, actorUid: string): Promise<Payment> {
  const ref = paymentRef(establishmentId, paymentId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); if (!snap.exists) throw new PaymentDomainError("not_found"); const current = snap.data() as Payment;
    if (current.channel !== "manual") throw new PaymentDomainError("not_manual");
    if (current.status === "paid" && current.manualConfirmationId === confirmationId) return current;
    let activeAttempt: PaymentAttempt | null = null;
    if (current.activeAttemptId) {
      const attempt = await tx.get(ref.collection("attempts").doc(current.activeAttemptId));
      if (!attempt.exists) throw new PaymentDomainError("active_attempt");
      activeAttempt = attempt.data() as PaymentAttempt;
      if (activeAttempt.channel === "provider" || activeAttempt.status !== "awaiting_customer") throw new PaymentDomainError("not_manual");
    }
    if (current.version !== expectedVersion) throw new PaymentDomainError("stale_version");
    assertTransition(current.status, "paid"); const now = Date.now(); const next: Payment = { ...current, status: "paid", paidAmountCents: current.amountCents, paidAt: now, manualConfirmationId: confirmationId, version: current.version + 1, updatedAt: now };
    if (activeAttempt) tx.update(ref.collection("attempts").doc(activeAttempt.id), { status: "paid", updatedAt: now });
    tx.update(ref, next as unknown as Record<string, unknown>); tx.create(ref.collection("events").doc(eventId("manual_payment_recorded", next.version)), event(next, "manual_payment_recorded", "manual", current.status, actorUid)); return next;
  });
}

export async function cancelPayment(establishmentId: string, paymentId: string, expectedVersion: number, actorUid: string): Promise<Payment> {
  const ref = paymentRef(establishmentId, paymentId);
  return db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new PaymentDomainError("not_found"); const current = snap.data() as Payment; if (current.status === "cancelled") return current; if (current.channel !== "manual") throw new PaymentDomainError("not_manual"); let activeAttempt: PaymentAttempt | null = null; let closeActiveAttempt = false; if (current.activeAttemptId) { const attempt = await tx.get(ref.collection("attempts").doc(current.activeAttemptId)); if (!attempt.exists) throw new PaymentDomainError("active_attempt"); activeAttempt = attempt.data() as PaymentAttempt; if (activeAttempt.channel === "provider" || !["awaiting_customer", "failed", "expired", "superseded"].includes(activeAttempt.status)) throw new PaymentDomainError("not_manual"); closeActiveAttempt = activeAttempt.status === "awaiting_customer"; } if (current.version !== expectedVersion) throw new PaymentDomainError("stale_version"); assertTransition(current.status, "cancelled"); const now = Date.now(); const next: Payment = { ...current, status: "cancelled", cancelledAt: now, version: current.version + 1, updatedAt: now }; if (activeAttempt && closeActiveAttempt) tx.update(ref.collection("attempts").doc(activeAttempt.id), { status: "cancelled", updatedAt: now }); tx.update(ref, next as unknown as Record<string, unknown>); tx.create(ref.collection("events").doc(eventId("payment_cancelled", next.version)), event(next, "payment_cancelled", "manual", current.status, actorUid)); return next; });
}

export async function getPaymentForOrder(establishmentId: string, orderId: string): Promise<Payment | null> { const snap = await paymentRef(establishmentId, paymentIdFor(orderId)).get(); return snap.exists ? snap.data() as Payment : null; }
// Contrato futuro; F12-B não contém adapter ou chamada externa.
export interface PaymentProviderContract { provider: string; capabilities(): PaymentProviderCapabilities; }
