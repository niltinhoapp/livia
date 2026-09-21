// Idempotência persistente + concorrência das mutações de pedido (OT de
// fechamento de lacunas do orders-mvp). Usa o harness compartilhado
// (firestoreFake) para exercitar de verdade as transações de lib/orders.ts —
// lib/orders.test.ts cobre só as funções puras (calculateItem/deliveryFee/
// normalizeOrderSettings) com um stub trivial, insuficiente pra isto.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
vi.mock("@/lib/whatsapp/client", () => ({
  normalizePhone: (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    return digits.length <= 11 ? `55${digits}` : digits;
  },
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  addOrderItem,
  confirmOrder,
  prepareOrderConfirmation,
  getActiveOrder,
  getOrder,
  removeOrderItem,
  saveMenuProduct,
  saveOrderSettings,
  setOrderAddress,
  setOrderFulfillment,
  setOrderPayment,
  updateOrderItem,
} from "@/lib/orders";
import type { MenuProduct } from "@/types";

const EST = "est-1";
const PHONE = "5511999990000";
const CONV = PHONE; // mesma convenção de lib/ai/tools.ts::orderConversationId (normalizePhone do contato)
const NAME = "Cliente Teste";

beforeEach(() => {
  fakeDb.reset();
});

async function seedProduct(priceCents = 1000, overrides: Partial<MenuProduct> = {}): Promise<MenuProduct> {
  return saveMenuProduct(EST, {
    categoryId: "cat-1",
    name: "X-Burger",
    basePriceCents: priceCents,
    active: true,
    variants: [],
    modifierGroups: [],
    ...overrides,
  });
}

async function readyToConfirm(product: MenuProduct) {
  await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1);
  await setOrderFulfillment(EST, CONV, PHONE, NAME, "pickup");
  await setOrderPayment(EST, CONV, PHONE, NAME, "cash");
  return prepareOrderConfirmation(EST, CONV, PHONE);
}

describe("Idempotência persistente — retry/reexecução da mesma operação lógica", () => {
  it("mesma operationId aplicada duas vezes (retry sequencial) não duplica o item", async () => {
    const product = await seedProduct();
    const opId = "toolcall.A1:add_order_item";
    const first = await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1, null, opId);
    const second = await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1, null, opId);
    expect(second.items.length).toBe(first.items.length);
    expect(second.version).toBe(first.version);
    expect(second.totalCents).toBe(first.totalCents);
  });

  it("mesma operationId disparada CONCORRENTEMENTE (reentrega simultânea) aplica só uma vez", async () => {
    const product = await seedProduct();
    await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1); // estabelece o draft antes, isola a variável testada
    const opId = "toolcall.A2:add_order_item";
    const [a, b] = await Promise.all([
      addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1, null, opId),
      addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1, null, opId),
    ]);
    expect(a.items.length).toBe(b.items.length);
    expect(a.version).toBe(b.version);
    const stored = await getOrder(EST, a.id);
    expect(stored?.items.length).toBe(2); // 1 do setup + 1 da operação (não 3)
  });

  it("operationIds DIFERENTES para o mesmo produto/quantidade aplicam cada uma — repetição intencional do cliente não é confundida com retry", async () => {
    const product = await seedProduct();
    const first = await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1, null, "toolcall.B1:add_order_item");
    const second = await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1, null, "toolcall.B2:add_order_item");
    expect(second.items.length).toBe(first.items.length + 1); // cliente pediu de novo numa mensagem nova — soma
    expect(second.totalCents).toBe(first.totalCents * 2);
  });

  it("retry aplica-se a update_order_item e remove_order_item também (não só add)", async () => {
    const product = await seedProduct();
    const created = await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1);
    const itemId = created.items[0]!.id;

    const opUpdate = "toolcall.C1:update_order_item";
    const u1 = await updateOrderItem(EST, CONV, PHONE, NAME, itemId, { quantity: 3 }, opUpdate);
    const u2 = await updateOrderItem(EST, CONV, PHONE, NAME, itemId, { quantity: 3 }, opUpdate); // retry
    expect(u2.items[0]!.quantity).toBe(3);
    expect(u2.version).toBe(u1.version);

    const opRemove = "toolcall.C2:remove_order_item";
    const r1 = await removeOrderItem(EST, CONV, PHONE, NAME, itemId, opRemove);
    const r2 = await removeOrderItem(EST, CONV, PHONE, NAME, itemId, opRemove); // retry pós-remoção: não deveria lançar "item não encontrado"
    expect(r1.items).toHaveLength(0);
    expect(r2.version).toBe(r1.version);
  });

  it("fulfillment, endereço e pagamento também persistem a operationId na mesma transação", async () => {
    const product = await seedProduct();
    await saveOrderSettings(EST, { deliveryEnabled: true, deliveryRules: [{ kind: "fixed", feeCents: 500 }] });
    await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1);

    const f1 = await setOrderFulfillment(EST, CONV, PHONE, NAME, "delivery", "toolcall.D1:fulfillment");
    const f2 = await setOrderFulfillment(EST, CONV, PHONE, NAME, "delivery", "toolcall.D1:fulfillment");
    expect(f2.version).toBe(f1.version);

    const a1 = await setOrderAddress(EST, CONV, PHONE, NAME, "Rua A, 1", null, null, "toolcall.D2:address");
    const a2 = await setOrderAddress(EST, CONV, PHONE, NAME, "Rua A, 1", null, null, "toolcall.D2:address");
    expect(a2.version).toBe(a1.version);

    const p1 = await setOrderPayment(EST, CONV, PHONE, NAME, "cash", null, "toolcall.D3:payment");
    const p2 = await setOrderPayment(EST, CONV, PHONE, NAME, "cash", null, "toolcall.D3:payment");
    expect(p2.version).toBe(p1.version);
  });

  it("sem operationId (ausência, ex.: mensagem sem waMessageId): comportamento antigo preservado — cada chamada aplica", async () => {
    const product = await seedProduct();
    const first = await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1);
    const second = await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1);
    expect(second.items.length).toBe(first.items.length + 1); // sem chave, não há dedupe — nunca bloqueia por engano
  });
});

describe("Concorrência — confirmação", () => {
  it("exige resumo persistido antes de confirmar e congela o snapshot canônico", async () => {
    const product = await seedProduct(1750);
    await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 2);
    await setOrderFulfillment(EST, CONV, PHONE, NAME, "pickup");
    const draft = await setOrderPayment(EST, CONV, PHONE, NAME, "cash");
    await expect(confirmOrder(EST, draft.id, draft.version, PHONE)).rejects.toThrow(/mudou/i);
    const summary = await prepareOrderConfirmation(EST, CONV, PHONE, "toolcall.summary-1");
    expect(summary.status).toBe("awaiting_confirmation");
    expect(summary.confirmationRequestedAt).not.toBeNull();
    const confirmed = await confirmOrder(EST, summary.id, summary.version, PHONE, "toolcall.confirm-1");
    expect(confirmed.snapshot).toMatchObject({ subtotalCents: 3500, discountCents: 0, deliveryFeeCents: 0, totalCents: 3500, fulfillment: "pickup", payment: { method: "cash" } });
    expect(confirmed.snapshot?.items[0]).toMatchObject({ productName: "X-Burger", quantity: 2, unitPriceCents: 1750, lineTotalCents: 3500 });
    expect(confirmed.operationalHistory?.at(-1)).toMatchObject({ from: "awaiting_confirmation", to: "confirmed", source: "customer_confirmation" });
  });

  it("alteração depois do resumo invalida a confirmação até haver novo resumo", async () => {
    const product = await seedProduct();
    const first = await readyToConfirm(product);
    const changed = await setOrderPayment(EST, CONV, PHONE, NAME, "cash", null, "toolcall.change-after-summary");
    expect(changed.status).toBe("draft");
    await expect(confirmOrder(EST, first.id, first.version, PHONE)).rejects.toThrow(/mudou/i);
    const refreshed = await prepareOrderConfirmation(EST, CONV, PHONE, "toolcall.summary-2");
    await expect(confirmOrder(EST, refreshed.id, refreshed.version, PHONE)).resolves.toMatchObject({ status: "confirmed" });
  });
  it("duas confirmações concorrentes do MESMO draft/version: só uma transição acontece, a outra converge pro mesmo resultado", async () => {
    const product = await seedProduct();
    const ready = await readyToConfirm(product);
    const [a, b] = await Promise.all([
      confirmOrder(EST, ready.id, ready.version, PHONE),
      confirmOrder(EST, ready.id, ready.version, PHONE),
    ]);
    expect(a.status).toBe("confirmed");
    expect(b.status).toBe("confirmed");
    expect(a.version).toBe(b.version); // nenhuma das duas produziu uma transição extra
    const stored = await getOrder(EST, ready.id);
    expect(stored?.status).toBe("confirmed");
    expect(stored?.version).toBe(a.version);
  });

  it("version stale: confirmar com expectedVersion desatualizado nunca confirma silenciosamente", async () => {
    const product = await seedProduct();
    await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1);
    const staleVersion = (await getActiveOrder(EST, CONV))!.version;
    await setOrderFulfillment(EST, CONV, PHONE, NAME, "pickup"); // avança a version de verdade
    const ready = await setOrderPayment(EST, CONV, PHONE, NAME, "cash"); // avança de novo

    await expect(confirmOrder(EST, ready.id, staleVersion, PHONE)).rejects.toThrow(/mudou/i);
    const stored = await getOrder(EST, ready.id);
    expect(stored?.status).not.toBe("confirmed");
  });

  it("retry após timeout na confirmação (mesma expectedVersion reenviada depois de já ter confirmado): retorna o pedido confirmado, nunca lança 'pedido mudou'", async () => {
    const product = await seedProduct();
    const ready = await readyToConfirm(product);
    const confirmed = await confirmOrder(EST, ready.id, ready.version, PHONE);
    // Retry com a MESMA (agora desatualizada) expectedVersion original — o
    // status já confirmado é checado ANTES do version, então isto nunca
    // deveria lançar "o pedido mudou".
    const retry = await confirmOrder(EST, ready.id, ready.version, PHONE);
    expect(retry.status).toBe("confirmed");
    expect(retry.version).toBe(confirmed.version);
  });
});

describe("Concorrência — mutações de item (sem idempotencyKey, itens genuinamente diferentes)", () => {
  it("duas mutações concorrentes (itens diferentes) aplicam ambas — nenhuma perda silenciosa de atualização", async () => {
    const product = await seedProduct();
    await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1); // cria o draft
    await Promise.all([
      addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1),
      addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 2),
    ]);
    const final = await getActiveOrder(EST, CONV);
    expect(final?.items).toHaveLength(3);
    // snapshot consistente: total sempre reflete a soma real dos itens, mesmo sob corrida
    const expectedTotal = final!.items.reduce((sum, item) => sum + item.lineTotalCents, 0);
    expect(final!.subtotalCents).toBe(expectedTotal);
    expect(final!.totalCents).toBe(expectedTotal); // pickup, sem taxa de entrega
  });

  it("mutação concorrente com confirmação não abre draft órfão e retry permanece inofensivo", async () => {
    const product = await seedProduct();
    const ready = await readyToConfirm(product);
    const itemsBeforeRace = ready.items.length;
    const operationId = "toolcall.confirm-race-add";
    const confirmation = confirmOrder(EST, ready.id, ready.version, PHONE);
    await Promise.resolve();
    const mutation = addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1, undefined, operationId);
    const [confirmationResult, mutationResult] = await Promise.allSettled([confirmation, mutation]);

    const stored = await getOrder(EST, ready.id);
    const orders = [...fakeDb.col(`establishments/${EST}/orders`).values()];
    const conversation = fakeDb.col(`establishments/${EST}/conversations`).get(CONV) as { activeOrderId?: string; lastConfirmedOrderId?: string } | undefined;
    expect(confirmationResult.status).toBe("fulfilled");
    expect(mutationResult.status).toBe("rejected");
    expect(stored?.status).toBe("confirmed");
    expect(stored?.items.length).toBe(itemsBeforeRace);
    expect(stored?.totalCents).toBe(ready.totalCents);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: ready.id, status: "confirmed" });
    expect((orders[0] as { items?: unknown[] } | undefined)?.items).toHaveLength(itemsBeforeRace);
    expect(conversation?.activeOrderId).toBeNull();
    expect(conversation?.lastConfirmedOrderId).toBe(ready.id);

    await expect(addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1, undefined, operationId)).rejects.toThrow(/confirmado/i);
    expect([...fakeDb.col(`establishments/${EST}/orders`).values()]).toHaveLength(1);
  });

  it("novo pedido explicitamente autorizado após confirmação continua possível", async () => {
    const product = await seedProduct();
    const ready = await readyToConfirm(product);
    await confirmOrder(EST, ready.id, ready.version, PHONE);

    const next = await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1, undefined, "toolcall.explicit-new-order", true);
    const active = await getActiveOrder(EST, CONV);

    expect(next.id).not.toBe(ready.id);
    expect(next.status).toBe("draft");
    expect(next.items).toHaveLength(1);
    expect(active?.id).toBe(next.id);
    expect([...fakeDb.col(`establishments/${EST}/orders`).values()]).toHaveLength(2);
  });
});

describe("Concorrência — alteração de catálogo durante draft/confirmação", () => {
  it("preço do produto muda depois do draft e antes de confirmar: confirmação rejeita, nunca confirma total desatualizado", async () => {
    const product = await seedProduct(1000);
    const ready = await readyToConfirm(product);
    await saveMenuProduct(EST, { categoryId: "cat-1", name: "X-Burger", basePriceCents: 2000, active: true, variants: [], modifierGroups: [] }, product.id);

    await expect(confirmOrder(EST, ready.id, ready.version, PHONE)).rejects.toThrow(/mudou de preço/i);
    const stored = await getOrder(EST, ready.id);
    expect(stored?.status).not.toBe("confirmed");
    expect(stored?.totalCents).toBe(ready.totalCents); // nunca alterado silenciosamente
  });

  it("produto desativado antes de confirmar rejeita a confirmação", async () => {
    const product = await seedProduct(1000);
    const ready = await readyToConfirm(product);
    await saveMenuProduct(EST, { categoryId: "cat-1", name: "X-Burger", basePriceCents: 1000, active: false, variants: [], modifierGroups: [] }, product.id);

    await expect(confirmOrder(EST, ready.id, ready.version, PHONE)).rejects.toThrow();
    const stored = await getOrder(EST, ready.id);
    expect(stored?.status).not.toBe("confirmed");
  });

  it("produto removido do catálogo (documento inexistente) antes de confirmar rejeita com mensagem clara", async () => {
    const product = await seedProduct(1000);
    const ready = await readyToConfirm(product);
    fakeDb.col(`establishments/${EST}/menuProducts`).delete(product.id);

    await expect(confirmOrder(EST, ready.id, ready.version, PHONE)).rejects.toThrow(/não está mais disponível/i);
  });

  it("catálogo muda DEPOIS de já confirmado: não afeta o pedido já confirmado (revalidação só roda na confirmação)", async () => {
    const product = await seedProduct(1000);
    const ready = await readyToConfirm(product);
    const confirmed = await confirmOrder(EST, ready.id, ready.version, PHONE);
    await saveMenuProduct(EST, { categoryId: "cat-1", name: "X-Burger", basePriceCents: 9999, active: false, variants: [], modifierGroups: [] }, product.id);

    const stored = await getOrder(EST, confirmed.id);
    expect(stored?.totalCents).toBe(confirmed.totalCents);
    expect(stored?.status).toBe("confirmed");
  });
});

describe("Isolamento de tenant", () => {
  it("mutações em establishment A nunca tocam pedidos/produtos de establishment B", async () => {
    const productA = await saveMenuProduct("est-A", { categoryId: "cat-1", name: "Produto A", basePriceCents: 500, active: true, variants: [], modifierGroups: [] });
    const productB = await saveMenuProduct("est-B", { categoryId: "cat-1", name: "Produto B", basePriceCents: 700, active: true, variants: [], modifierGroups: [] });

    await addOrderItem("est-A", PHONE, PHONE, NAME, productA.id, null, [], 1);
    const orderA = await getActiveOrder("est-A", PHONE);
    const orderB = await getActiveOrder("est-B", PHONE);

    expect(orderA?.items).toHaveLength(1);
    expect(orderB).toBeNull(); // nunca criado em B só porque A criou em A
  });
});
