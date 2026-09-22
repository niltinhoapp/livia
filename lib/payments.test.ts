import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { db: fake.fakeDb, sub: fake.sub };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { cancelPayment, createPaymentAttempt, createPaymentForOrder, getPaymentForOrder, PAYMENT_TRANSITIONS, recordManualPayment } from "@/lib/payments";

const EST = "est-a";
const OTHER = "est-b";
const ORDER = "order-1";
const paymentPath = `establishments/${EST}/payments/order_${ORDER}`;

function order(status = "confirmed", establishmentId = EST, snapshot = true) {
  return { id: ORDER, establishmentId, status, version: 7, snapshot: snapshot ? { totalCents: 2590, payment: { method: "pix" } } : null };
}
async function seed(input = order()) { await fakeDb.collection(`establishments/${input.establishmentId}/orders`).doc(ORDER).set(input); }
async function events() { return (await fakeDb.collection(`${paymentPath}/events`).get()).docs.map((doc) => doc.data()); }
async function attempt(id: string) { return (await fakeDb.collection(`${paymentPath}/attempts`).doc(id).get()).data(); }

beforeEach(() => fakeDb.reset());

describe("Payments Core", () => {
  it("só nasce de snapshot confirmado, em BRL e com o total congelado", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    expect(payment).toMatchObject({ amountCents: 2590, currency: "BRL", orderVersion: 7, method: "manual_pix", status: "awaiting_customer" });
  });

  it("aceita estados operacionais pós-confirmação, inclusive completed", async () => {
    for (const status of ["confirmed", "accepted", "preparing", "ready_for_pickup", "out_for_delivery", "completed"]) {
      fakeDb.reset(); await seed(order(status));
      await expect(createPaymentForOrder(EST, ORDER)).resolves.toMatchObject({ status: "awaiting_customer" });
    }
  });

  it("rejeita draft, awaiting_confirmation, cancelado, snapshot ausente e outro tenant", async () => {
    for (const input of [order("draft"), order("awaiting_confirmation"), order("cancelled"), order("confirmed", EST, false)]) {
      fakeDb.reset(); await seed(input);
      await expect(createPaymentForOrder(EST, ORDER)).rejects.toMatchObject({ code: "order_not_confirmed" });
    }
    fakeDb.reset(); await seed(order("confirmed", OTHER));
    await expect(createPaymentForOrder(EST, ORDER)).rejects.toMatchObject({ code: "not_found" });
  });

  it("createPayment × createPayment converge para Payment e evento únicos", async () => {
    await seed(); const results = await Promise.all([createPaymentForOrder(EST, ORDER), createPaymentForOrder(EST, ORDER)]);
    expect(results[0].id).toBe(results[1].id);
    const history = await events();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ type: "payment_created", previousStatus: null, nextStatus: "awaiting_customer", provider: null });
  });

  it("attempt com mesma key × mesma key é idempotente e não duplica evento", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    const [first, same] = await Promise.all([createPaymentAttempt(EST, payment.id, "intent-1"), createPaymentAttempt(EST, payment.id, "intent-1")]);
    expect(first).toMatchObject({ id: "intent-1", ordinal: 1, status: "awaiting_customer" }); expect(same).toEqual(first);
    expect(await events()).toHaveLength(2);
  });

  it("attempt A × attempt B deixa somente uma ativa e supersede a anterior", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    await Promise.all([createPaymentAttempt(EST, payment.id, "attempt-a"), createPaymentAttempt(EST, payment.id, "attempt-b")]);
    const stored = await getPaymentForOrder(EST, ORDER); const a = await attempt("attempt-a"); const b = await attempt("attempt-b");
    expect([a?.status, b?.status].filter((status) => status === "awaiting_customer")).toHaveLength(1);
    expect(["attempt-a", "attempt-b"]).toContain(stored?.activeAttemptId);
    expect([a?.status, b?.status]).toContain("superseded");
  });

  it("troca provider → manual somente supersede tentativa awaiting e atualiza o pai", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    const provider = await createPaymentAttempt(EST, payment.id, "provider-pix", { channel: "provider", provider: "mercado_pago", method: "pix" });
    const manual = await createPaymentAttempt(EST, payment.id, "manual-pix", { channel: "manual", method: "manual_pix" });
    expect(await attempt(provider.id)).toMatchObject({ status: "superseded", channel: "provider" }); expect(manual).toMatchObject({ status: "awaiting_customer", channel: "manual" });
    expect(await getPaymentForOrder(EST, ORDER)).toMatchObject({ channel: "manual", provider: null, activeAttemptId: manual.id });
  });

  it("provider attempt × confirmação manual não permite pagamento manual enquanto provider está ativo", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    const results = await Promise.allSettled([createPaymentAttempt(EST, payment.id, "provider", { channel: "provider", provider: "mercado_pago", method: "pix" }), recordManualPayment(EST, payment.id, payment.version, "manual", "owner-a")]);
    const stored = await getPaymentForOrder(EST, ORDER);
    if (stored?.channel === "provider") expect(stored.status).toBe("awaiting_customer"); else expect(stored?.status).toBe("paid");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("createAttempt × manual paid tem uma única mutação financeira vencedora", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    const results = await Promise.allSettled([createPaymentAttempt(EST, payment.id, "manual-attempt", { channel: "manual", method: "cash" }), recordManualPayment(EST, payment.id, payment.version, "manual", "owner-a")]);
    expect(["awaiting_customer", "paid"]).toContain((await getPaymentForOrder(EST, ORDER))?.status);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("manual paid × cancel usa expectedVersion: exatamente uma vence", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    const results = await Promise.allSettled([recordManualPayment(EST, payment.id, payment.version, "manual", "owner-a"), cancelPayment(EST, payment.id, payment.version, "owner-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(["paid", "cancelled"]).toContain((await getPaymentForOrder(EST, ORDER))?.status);
  });

  it("cancelamento manual encerra a attempt manual ativa na mesma transação", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    const active = await createPaymentAttempt(EST, payment.id, "cash", { channel: "manual", method: "cash" });
    await cancelPayment(EST, payment.id, 2, "owner-a");
    expect(await attempt(active.id)).toMatchObject({ status: "cancelled" });
    expect(await getPaymentForOrder(EST, ORDER)).toMatchObject({ status: "cancelled" });
  });

  it("duas confirmações manuais concorrentes deixam um único evento e actor auditável", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    const results = await Promise.allSettled([recordManualPayment(EST, payment.id, 1, "a", "owner-a"), recordManualPayment(EST, payment.id, 1, "b", "owner-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const manualEvents = (await events()).filter((entry) => entry.type === "manual_payment_recorded");
    expect(manualEvents).toHaveLength(1); expect(manualEvents[0]).toMatchObject({ previousStatus: "awaiting_customer", nextStatus: "paid", source: "manual", actorUid: "owner-a" });
  });

  it("retry da confirmação manual não duplica evento", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    const paid = await recordManualPayment(EST, payment.id, 1, "same", "owner-a");
    await expect(recordManualPayment(EST, payment.id, 1, "same", "owner-a")).resolves.toEqual(paid);
    expect((await events()).filter((entry) => entry.type === "manual_payment_recorded")).toHaveLength(1);
  });

  it("attempt criada registra provider da tentativa e transição do Payment", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    await createPaymentAttempt(EST, payment.id, "provider-pix", { channel: "provider", provider: "mercado_pago", method: "pix" });
    const entry = (await events()).find((item) => item.type === "attempt_created");
    expect(entry).toMatchObject({ previousStatus: "awaiting_customer", nextStatus: "awaiting_customer", provider: "mercado_pago", actorUid: null });
  });

  it("não permite nova attempt enquanto Payment está processing ou authorized", async () => {
    for (const status of ["processing", "authorized"]) {
      fakeDb.reset(); await seed(); const payment = await createPaymentForOrder(EST, ORDER);
      await fakeDb.collection(`establishments/${EST}/payments`).doc(payment.id).update({ status });
      await expect(createPaymentAttempt(EST, payment.id, `blocked-${status}`)).rejects.toMatchObject({ code: "invalid_transition" });
    }
  });

  it("mantém recuperação explícita de refund e falha de captura após autorização", () => {
    expect(PAYMENT_TRANSITIONS.refund_pending).toContain("paid");
    expect(PAYMENT_TRANSITIONS.authorized).toContain("failed");
    expect(PAYMENT_TRANSITIONS.paid).not.toContain("processing");
  });

  it("não aceita método manual em tentativa provider", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    await expect(createPaymentAttempt(EST, payment.id, "invalid-provider", { channel: "provider", provider: "mercado_pago", method: "manual_pix" })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("paid não volta a processing, cancelamento pendente é idempotente e tenant permanece isolado", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER); const paid = await recordManualPayment(EST, payment.id, 1, "a", "owner-a");
    await expect(cancelPayment(EST, paid.id, paid.version, "owner-a")).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(cancelPayment(OTHER, payment.id, payment.version, "owner-b")).rejects.toMatchObject({ code: "not_found" });
    fakeDb.reset(); await seed(); const pending = await createPaymentForOrder(EST, ORDER); const cancelled = await cancelPayment(EST, pending.id, pending.version, "owner-a");
    await expect(cancelPayment(EST, cancelled.id, cancelled.version, "owner-a")).resolves.toMatchObject({ status: "cancelled" });
  });

  it("não introduz billing SaaS nem dados de cartão no Payment", async () => {
    await seed(); const payment = await createPaymentForOrder(EST, ORDER);
    expect(payment).not.toHaveProperty("billing"); expect(JSON.stringify(payment)).not.toMatch(/pan|cvv|token/i);
  });
});
