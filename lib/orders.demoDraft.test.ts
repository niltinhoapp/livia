import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/firebase/admin", async () => { const fake = await import("@/lib/__testing__/firestoreFake"); return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb }; });
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  addOrderItem,
  confirmOrder,
  getActiveOrder,
  prepareOrderConfirmation,
  removeOrderItem,
  saveMenuCategory,
  saveMenuProduct,
  saveOrderSettings,
  setOrderAddress,
  setOrderFulfillment,
  setOrderPayment,
  transitionOrder,
  updateOrderItem,
} from "./orders";
import { createPaymentForOrder } from "./payments";
import type { DemoAuthorization } from "./demoAuthorization";

const EST = "demo"; const CONV = "5511999999999"; const demo: Extract<DemoAuthorization, { authorized: true }> = { authorized: true, establishmentId: EST, prospectingLeadId: "lead-a" };
async function seed() {
  fakeDb.col("establishments").set(EST, { id: EST, bot: { ordersEnabled: true } });
  fakeDb.col(`establishments/${EST}/conversations`).set(CONV, { id: CONV });
  await saveMenuCategory(EST, { name: "Lanches", active: true }, "cat");
  await saveMenuProduct(EST, { categoryId: "cat", name: "X", basePriceCents: 1000, active: true }, "prod");
}
const add = (authorization?: typeof demo) => addOrderItem(EST, CONV, CONV, null, "prod", null, [], 1, null, undefined, false, undefined, authorization);
describe("draft demo de addOrderItem", () => {
  beforeEach(async () => { fakeDb.reset(); await seed(); });
  it("cria draft demo já marcado com lead", async () => { await add(demo); expect(await getActiveOrder(EST, CONV)).toMatchObject({ mode: "demo", prospectingLeadId: "lead-a" }); });
  it("preserva o draft para o mesmo lead", async () => { const first = await add(demo); const second = await add(demo); expect(second.id).toBe(first.id); expect(second).toMatchObject({ mode: "demo", prospectingLeadId: "lead-a" }); });
  it("recusa outro lead", async () => { await add(demo); await expect(add({ ...demo, prospectingLeadId: "lead-b" })).rejects.toThrow("draft_scope_mismatch"); });
  it("recusa demo sobre draft comercial", async () => { await add(); await expect(add(demo)).rejects.toThrow("draft_scope_mismatch"); });
  it("recusa comercial sobre draft demo", async () => { await add(demo); await expect(add()).rejects.toThrow("draft_scope_mismatch"); });
  it("fluxo comercial cria draft normal", async () => { await add(); const order = await getActiveOrder(EST, CONV); expect(order?.mode).toBeUndefined(); expect(order?.prospectingLeadId).toBeUndefined(); });
  it("ausência de autorização nunca cria demo", async () => { await add(undefined); expect((await getActiveOrder(EST, CONV))?.mode).toBeUndefined(); });
  it("não substitui lead demo existente", async () => { await add(demo); await expect(add({ ...demo, prospectingLeadId: "other" })).rejects.toThrow("draft_scope_mismatch"); expect((await getActiveOrder(EST, CONV))?.prospectingLeadId).toBe("lead-a"); });
  it("mesmo lead atualiza item demo preservando metadados", async () => { const first = await add(demo); const updated = await updateOrderItem(EST, CONV, CONV, null, first.items[0]!.id, { quantity: 2 }, undefined, undefined, demo); expect(updated).toMatchObject({ mode: "demo", prospectingLeadId: "lead-a" }); expect(updated.items[0]?.quantity).toBe(2); });
  it("outro lead não atualiza draft demo", async () => { const first = await add(demo); await expect(updateOrderItem(EST, CONV, CONV, null, first.items[0]!.id, { quantity: 2 }, undefined, undefined, { ...demo, prospectingLeadId: "other" })).rejects.toThrow("draft_scope_mismatch"); });
  it("comercial atualiza draft comercial", async () => { const first = await add(); const updated = await updateOrderItem(EST, CONV, CONV, null, first.items[0]!.id, { quantity: 2 }); expect(updated.mode).toBeUndefined(); expect(updated.items[0]?.quantity).toBe(2); });

  it("percorre o ciclo demo completo sem criar efeitos operacionais externos", async () => {
    await saveOrderSettings(EST, { deliveryEnabled: true, deliveryRules: [{ kind: "fixed", feeCents: 500 }] });
    const first = await add(demo);
    const updated = await updateOrderItem(EST, CONV, CONV, null, first.items[0]!.id, { quantity: 2 }, undefined, undefined, demo);
    const extra = await addOrderItem(EST, CONV, CONV, null, "prod", null, [], 1, null, undefined, false, undefined, demo);
    const removed = await removeOrderItem(EST, CONV, CONV, null, extra.items.at(-1)!.id, undefined, undefined, demo);
    const fulfillment = await setOrderFulfillment(EST, CONV, CONV, null, "delivery", undefined, undefined, demo);
    const addressed = await setOrderAddress(EST, CONV, CONV, null, "Rua Demo, 1", "Centro", null, undefined, undefined, demo);
    const paid = await setOrderPayment(EST, CONV, CONV, null, "pix", null, undefined, undefined, demo);
    const prepared = await prepareOrderConfirmation(EST, CONV, CONV, undefined, undefined, demo);
    const confirmed = await confirmOrder(EST, prepared.id, prepared.version, CONV, undefined, undefined, demo);

    for (const order of [updated, extra, removed, fulfillment, addressed, paid, prepared, confirmed]) {
      expect(order).toMatchObject({ mode: "demo", prospectingLeadId: "lead-a" });
    }
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.items).toHaveLength(1);
    expect(confirmed.deliveryAddress).toMatchObject({ raw: "Rua Demo, 1" });
    await expect(createPaymentForOrder(EST, confirmed.id)).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(transitionOrder(EST, confirmed.id, "accepted", confirmed.version)).rejects.toMatchObject({ code: "invalid_transition" });
    expect(fakeDb.col(`establishments/${EST}/orderNotifications`).size).toBe(0);
  });

  it("fluxo comercial completo continua sem metadados demo", async () => {
    const first = await add();
    const pickup = await setOrderFulfillment(EST, CONV, CONV, null, "pickup");
    const payment = await setOrderPayment(EST, CONV, CONV, null, "cash");
    const prepared = await prepareOrderConfirmation(EST, CONV, CONV);
    const confirmed = await confirmOrder(EST, prepared.id, prepared.version, CONV);
    for (const order of [first, pickup, payment, prepared, confirmed]) {
      expect(order.mode).toBeUndefined();
      expect(order.prospectingLeadId).toBeUndefined();
    }
    expect(confirmed.status).toBe("confirmed");
  });
});
