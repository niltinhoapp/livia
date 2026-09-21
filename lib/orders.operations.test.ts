import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTemplate = vi.fn();
vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
vi.mock("@/lib/whatsapp/client", () => ({ normalizePhone: (value: string) => value.replace(/\D/g, "") }));
vi.mock("@/lib/whatsapp/sender", () => ({ sendTemplate: (...args: unknown[]) => sendTemplate(...args) }));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { getOrder, listOrders, transitionOrder } from "@/lib/orders";
import type { FoodOrder, FoodOrderSnapshot, OrderStatus } from "@/types";

const EST_A = "est-a";
const EST_B = "est-b";

function snapshot(fulfillment: "pickup" | "delivery"): FoodOrderSnapshot {
  return {
    items: [{ id: "item-1", productId: "product-1", productName: "X-Burguer confirmado", variantId: "large", variantName: "Grande", quantity: 2, unitPriceCents: 2500, modifiers: [{ optionId: "bacon", name: "Bacon", priceDeltaCents: 400 }], notes: "sem cebola", lineTotalCents: 5000 }],
    subtotalCents: 5000,
    discountCents: 500,
    deliveryFeeCents: fulfillment === "delivery" ? 700 : 0,
    totalCents: fulfillment === "delivery" ? 5200 : 4500,
    fulfillment,
    deliveryAddress: fulfillment === "delivery" ? { raw: "Rua A, 10", neighborhood: "Centro", reference: "Portão azul" } : null,
    payment: { method: "pix", status: "pending", changeForCents: null },
    createdAt: 1000,
  };
}

function order(id: string, status: OrderStatus = "confirmed", fulfillment: "pickup" | "delivery" = "pickup", version = 3): FoodOrder {
  const frozen = snapshot(fulfillment);
  return {
    id, establishmentId: EST_A, conversationId: "conv-1", contactPhone: "5511999990000", contactName: "Cliente",
    status, fulfillment, deliveryAddress: frozen.deliveryAddress, deliveryFeeCents: frozen.deliveryFeeCents, discountCents: frozen.discountCents,
    payment: frozen.payment, items: frozen.items, subtotalCents: frozen.subtotalCents, totalCents: frozen.totalCents,
    version, confirmationRequestedAt: 900, snapshot: frozen, operationalHistory: [{ from: "awaiting_confirmation", to: "confirmed", at: 1000, source: "customer_confirmation" }],
    createdAt: 500, updatedAt: 1000, confirmedAt: 1000,
  };
}

function seed(establishmentId: string, value: FoodOrder) {
  fakeDb.col(`establishments/${establishmentId}/orders`).set(value.id, { ...value, establishmentId });
}

beforeEach(() => { fakeDb.reset(); sendTemplate.mockReset(); });

describe("fila operacional", () => {
  it("lista pedido confirmado e exclui draft e awaiting_confirmation", async () => {
    seed(EST_A, order("confirmed"));
    seed(EST_A, order("draft", "draft"));
    seed(EST_A, order("awaiting", "awaiting_confirmation"));
    const listed = await listOrders(EST_A);
    expect(listed.map((item) => item.id)).toEqual(["confirmed"]);
    await expect(transitionOrder(EST_A, "draft", "draft", 3)).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("prioriza ativos e mantém encerrados disponíveis", async () => {
    seed(EST_A, { ...order("closed", "completed"), updatedAt: 5000 });
    seed(EST_A, { ...order("new", "confirmed"), createdAt: 700 });
    seed(EST_A, { ...order("preparing", "preparing"), createdAt: 100 });
    expect((await listOrders(EST_A)).map((item) => item.id)).toEqual(["new", "preparing", "closed"]);
  });
});

describe("máquina de estados operacional", () => {
  it("executa o fluxo completo de entrega sem saltos", async () => {
    seed(EST_A, order("delivery", "confirmed", "delivery"));
    const accepted = await transitionOrder(EST_A, "delivery", "accepted", 3);
    const preparing = await transitionOrder(EST_A, "delivery", "preparing", accepted.version);
    const ready = await transitionOrder(EST_A, "delivery", "ready_for_pickup", preparing.version);
    const out = await transitionOrder(EST_A, "delivery", "out_for_delivery", ready.version);
    const completed = await transitionOrder(EST_A, "delivery", "completed", out.version);
    expect(completed.status).toBe("completed");
    expect(completed.operationalHistory?.map((entry) => entry.to)).toEqual(["confirmed", "accepted", "preparing", "ready_for_pickup", "out_for_delivery", "completed"]);
  });

  it("executa retirada de pronto diretamente para concluído e rejeita saiu para entrega", async () => {
    seed(EST_A, order("pickup", "ready_for_pickup", "pickup", 6));
    await expect(transitionOrder(EST_A, "pickup", "out_for_delivery", 6)).rejects.toMatchObject({ code: "invalid_transition" });
    const completed = await transitionOrder(EST_A, "pickup", "completed", 6);
    expect(completed.status).toBe("completed");
  });

  it("rejeita saltos e não avança pedidos concluídos ou cancelados", async () => {
    seed(EST_A, order("skip", "confirmed"));
    seed(EST_A, order("completed", "completed"));
    seed(EST_A, order("cancelled", "cancelled"));
    await expect(transitionOrder(EST_A, "skip", "completed", 3)).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(transitionOrder(EST_A, "completed", "accepted", 3)).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(transitionOrder(EST_A, "cancelled", "accepted", 3)).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("cancelamento e mudança normal acrescentam histórico sem apagar o anterior", async () => {
    seed(EST_A, order("normal"));
    seed(EST_A, order("cancel"));
    const accepted = await transitionOrder(EST_A, "normal", "accepted", 3);
    const cancelled = await transitionOrder(EST_A, "cancel", "cancelled", 3);
    expect(accepted.operationalHistory).toHaveLength(2);
    expect(accepted.operationalHistory?.at(-1)).toMatchObject({ from: "confirmed", to: "accepted", source: "panel" });
    expect(cancelled.operationalHistory?.at(-1)).toMatchObject({ from: "confirmed", to: "cancelled", source: "panel" });
  });

  it("retry da mesma transição é idempotente", async () => {
    seed(EST_A, order("retry"));
    const first = await transitionOrder(EST_A, "retry", "accepted", 3);
    const retry = await transitionOrder(EST_A, "retry", "accepted", 3);
    expect(retry.version).toBe(first.version);
    expect(retry.operationalHistory).toHaveLength(first.operationalHistory!.length);
  });

  it("duas abas com a mesma versão não permitem regressão nem overwrite", async () => {
    seed(EST_A, order("race"));
    const results = await Promise.allSettled([
      transitionOrder(EST_A, "race", "accepted", 3),
      transitionOrder(EST_A, "race", "cancelled", 3),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await getOrder(EST_A, "race"))?.version).toBe(4);
  });

  it("duplo clique concorrente na mesma ação produz uma única mudança", async () => {
    seed(EST_A, order("double"));
    const [first, second] = await Promise.all([
      transitionOrder(EST_A, "double", "accepted", 3),
      transitionOrder(EST_A, "double", "accepted", 3),
    ]);
    expect(first.version).toBe(second.version);
    expect((await getOrder(EST_A, "double"))?.operationalHistory).toHaveLength(2);
  });

  it("versão antiga é rejeitada antes de sobrescrever estado novo", async () => {
    seed(EST_A, order("stale"));
    await transitionOrder(EST_A, "stale", "accepted", 3);
    await expect(transitionOrder(EST_A, "stale", "cancelled", 3)).rejects.toMatchObject({ code: "stale_version" });
    expect((await getOrder(EST_A, "stale"))?.status).toBe("accepted");
  });

  it("preserva o snapshot confirmado e não envia WhatsApp", async () => {
    const original = order("snapshot"); seed(EST_A, original);
    const accepted = await transitionOrder(EST_A, "snapshot", "accepted", 3);
    expect(accepted.snapshot).toEqual(original.snapshot);
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});

describe("isolamento por estabelecimento", () => {
  it("A não lê, lista nem altera pedido de B", async () => {
    seed(EST_B, order("private"));
    await expect(getOrder(EST_A, "private")).resolves.toBeNull();
    await expect(listOrders(EST_A)).resolves.toEqual([]);
    await expect(transitionOrder(EST_A, "private", "accepted", 3)).rejects.toMatchObject({ code: "not_found" });
    expect((await getOrder(EST_B, "private"))?.status).toBe("confirmed");
  });
});
