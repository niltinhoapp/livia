import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
vi.mock("@/lib/whatsapp/client", () => ({ normalizePhone: (value: string) => value }));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { addOrderItem, confirmOrder, getActiveOrder, getOrder, getOrderIntakeStatus, prepareOrderConfirmation, saveMenuProduct, saveOrderSettings, setOrderFulfillment, setOrderPayment } from "@/lib/orders";
import { defaultScheduleConfig, saveScheduleConfig } from "@/lib/scheduling";
import type { Establishment } from "@/types";

const A = "est-a", B = "est-b", PHONE = "5511999000000";
const now = new Date("2026-09-21T16:00:00.000Z").getTime(); // segunda 13:00 São Paulo
const tenant = (id: string, ordersEnabled: boolean): Establishment => ({ id, name: id, type: "lanchonete", ownerUid: id, status: "active", createdAt: 0, bot: { personaName: "Livia", tone: "", bookingEnabled: false, ordersEnabled, handoffKeywords: [], medicalGuardrail: false } });

beforeEach(async () => {
  fakeDb.reset(); vi.setSystemTime(now);
  fakeDb.col("establishments").set(A, tenant(A, true) as unknown as Record<string, unknown>);
  fakeDb.col("establishments").set(B, tenant(B, false) as unknown as Record<string, unknown>);
  await saveScheduleConfig(A, { ...defaultScheduleConfig(A), days: { "0": null, "1": { open: "09:00", close: "23:00" }, "2": null, "3": null, "4": null, "5": null, "6": null } });
});

describe("janela canônica para novos pedidos", () => {
  it("ordersEnabled=false bloqueia no backend e A não usa a configuração de B", async () => {
    expect(await getOrderIntakeStatus(B)).toMatchObject({ open: false, reason: "orders_disabled" });
    expect(await getOrderIntakeStatus(A)).toMatchObject({ open: true });
  });

  it("sem horário específico, reflete mudanças posteriores do ScheduleConfig sem copiar o expediente", async () => {
    expect(await getOrderIntakeStatus(A)).toMatchObject({ open: true });
    await saveScheduleConfig(A, { ...defaultScheduleConfig(A), days: { "0": null, "1": null, "2": null, "3": null, "4": null, "5": null, "6": null } });
    expect(await getOrderIntakeStatus(A)).toMatchObject({ open: false, reason: "outside_order_hours", nextOpening: null });
  });

  it("janela específica fechada bloqueia novo draft e devolve a próxima abertura estruturada", async () => {
    await saveOrderSettings(A, { orderHours: { days: { "0": null, "1": { open: "18:00", close: "01:00" }, "2": null, "3": null, "4": null, "5": null, "6": null } } });
    await expect(getOrderIntakeStatus(A)).resolves.toMatchObject({ open: false, reason: "outside_order_hours", nextOpening: { date: "2026-09-21", time: "18:00" } });
    const product = await saveMenuProduct(A, { categoryId: "c", name: "X", basePriceCents: 1000, active: true, variants: [], modifierGroups: [] });
    await expect(addOrderItem(A, PHONE, PHONE, null, product.id, null, [], 1)).rejects.toMatchObject({ status: { reason: "outside_order_hours" } });
    expect(await getActiveOrder(A, PHONE)).toBeNull();
  });

  it("carrinho existente continua mutável depois do fechamento, mas não abre outro", async () => {
    const product = await saveMenuProduct(A, { categoryId: "c", name: "X", basePriceCents: 1000, active: true, variants: [], modifierGroups: [] });
    await addOrderItem(A, PHONE, PHONE, null, product.id, null, [], 1);
    await saveOrderSettings(A, { orderHours: { days: { "0": null, "1": { open: "18:00", close: "01:00" }, "2": null, "3": null, "4": null, "5": null, "6": null } } });
    const updated = await addOrderItem(A, PHONE, PHONE, null, product.id, null, [], 1);
    expect(updated.items).toHaveLength(2);
  });

  it("carrinho iniciado antes do fechamento pode ser resumido e confirmado, sem abrir outro draft", async () => {
    const product = await saveMenuProduct(A, { categoryId: "c", name: "X", basePriceCents: 1000, active: true, variants: [], modifierGroups: [] });
    const started = await addOrderItem(A, PHONE, PHONE, null, product.id, null, [], 1);
    await saveOrderSettings(A, { orderHours: { days: { "0": null, "1": { open: "18:00", close: "01:00" }, "2": null, "3": null, "4": null, "5": null, "6": null } } });
    await setOrderFulfillment(A, PHONE, PHONE, null, "pickup");
    await setOrderPayment(A, PHONE, PHONE, null, "cash");
    const prepared = await prepareOrderConfirmation(A, PHONE, PHONE);
    const confirmed = await confirmOrder(A, prepared.id, prepared.version, PHONE);

    expect(confirmed.status).toBe("confirmed");
    expect(await getActiveOrder(A, PHONE)).toBeNull();
    expect(await getOrder(A, started.id)).toMatchObject({ id: started.id, status: "confirmed" });
  });
});
