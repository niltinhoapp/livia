// F4 da Lívia Alimentação V2 — robustez do carrinho e do tool loop.
//
// Cobre: troca de variação/adicional em item já no carrinho, o fallback
// quando o loop de ferramentas estoura com pedido em andamento, as travas
// contra mutação duplicada (que já existiam e aqui ficam travadas por
// teste), e a garantia da F3 de que a Livia nunca dá pagamento por
// confirmado.
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
import { composeOrderReply } from "@/lib/ai/orderReply";
import { runTool, type ToolContext } from "@/lib/ai/tools";
import { getActiveOrder, saveMenuCategory, saveMenuProduct, saveOrderSettings } from "@/lib/orders";
import type { Establishment } from "@/types";

const EST = "est-lanchonete";
const PHONE = "5514991234567";

const ctx = (): ToolContext => ({
  est: {
    id: EST, name: "Lanchonete Teste", type: "lanchonete", ownerUid: EST, status: "active", createdAt: 0,
    bot: { personaName: "Lívia", tone: "acolhedora", bookingEnabled: false, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
  } as unknown as Establishment,
  kb: null, config: null, contactPhone: PHONE, contactName: "Cliente", offset: -180, customerProfile: null,
});

beforeEach(() => {
  fakeDb.reset();
});

async function seedPizza() {
  const categoria = await saveMenuCategory(EST, { name: "Pizzas", sortOrder: 0 });
  return saveMenuProduct(EST, {
    categoryId: categoria.id, name: "Pizza Calabresa", basePriceCents: 4000, active: true,
    variants: [
      { id: "media", name: "Média", priceDeltaCents: 0, active: true },
      { id: "grande", name: "Grande", priceDeltaCents: 1500, active: true },
      { id: "familia", name: "Família", priceDeltaCents: 2500, active: false },
    ],
    modifierGroups: [{
      id: "extras", name: "Adicionais", required: false, minSelections: 0, maxSelections: 2,
      options: [
        { id: "borda", name: "Borda recheada", priceDeltaCents: 800, active: true },
        { id: "cebola", name: "Cebola", priceDeltaCents: 0, active: true },
      ],
    }],
  });
}
const itemIdOf = (data: unknown) => (data as { items: { id: string }[] }).items[0]!.id;

describe("trocar tamanho e adicional de item já no carrinho", () => {
  it("troca o tamanho numa operação só e recalcula o preço pelo backend", async () => {
    const pizza = await seedPizza();
    const added = await runTool("add_order_item", { productId: pizza.id, variantId: "media", quantity: 1 }, ctx());
    expect((added.data as { totalCents: number }).totalCents).toBe(4000);

    const updated = await runTool("update_order_item", { itemId: itemIdOf(added.data), variantId: "grande" }, ctx());

    const data = updated.data as { items: { variant: string | null; quantity: number }[]; totalCents: number };
    expect(data.items).toHaveLength(1); // não virou remove + add
    expect(data.items[0]!.variant).toBe("Grande");
    expect(data.totalCents).toBe(5500);
  });

  it("tira um adicional já escolhido sem mexer no resto do item", async () => {
    const pizza = await seedPizza();
    const added = await runTool("add_order_item", { productId: pizza.id, variantId: "media", modifierOptionIds: ["borda", "cebola"], quantity: 2, notes: "bem assada" }, ctx());
    expect((added.data as { totalCents: number }).totalCents).toBe(9600);

    const updated = await runTool("update_order_item", { itemId: itemIdOf(added.data), modifierOptionIds: ["borda"] }, ctx());

    const data = updated.data as { items: { modifiers: string[]; quantity: number; notes: string | null }[]; totalCents: number };
    expect(data.items[0]!.modifiers).toEqual(["Borda recheada"]);
    expect(data.items[0]!.quantity).toBe(2);
    expect(data.items[0]!.notes).toBe("bem assada");
    // Cebola é adicional grátis: sair do item não pode mexer no total.
    expect(data.totalCents).toBe(9600);
  });

  it("tirar um adicional pago abaixa o total, recalculado pelo backend", async () => {
    const pizza = await seedPizza();
    const added = await runTool("add_order_item", { productId: pizza.id, variantId: "media", modifierOptionIds: ["borda"], quantity: 2 }, ctx());
    expect((added.data as { totalCents: number }).totalCents).toBe((4000 + 800) * 2);

    const updated = await runTool("update_order_item", { itemId: itemIdOf(added.data), modifierOptionIds: [] }, ctx());

    const data = updated.data as { items: { modifiers: string[] }[]; totalCents: number };
    expect(data.items[0]!.modifiers).toEqual([]);
    expect(data.totalCents).toBe(8000);
  });

  it("recusa variação indisponível em vez de aceitar a troca", async () => {
    const pizza = await seedPizza();
    const added = await runTool("add_order_item", { productId: pizza.id, variantId: "media", quantity: 1 }, ctx());

    const result = await runTool("update_order_item", { itemId: itemIdOf(added.data), variantId: "familia" }, ctx());

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Variação indisponível/i);
    expect((await getActiveOrder(EST, PHONE))?.items[0]?.variantName).toBe("Média");
  });

  it("recusa adicional que não existe no produto", async () => {
    const pizza = await seedPizza();
    const added = await runTool("add_order_item", { productId: pizza.id, variantId: "media", quantity: 1 }, ctx());

    const result = await runTool("update_order_item", { itemId: itemIdOf(added.data), modifierOptionIds: ["cheddar-inventado"] }, ctx());

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/indisponível/i);
  });

  it("quantidade e observação continuam funcionando sozinhas, sem tocar na composição", async () => {
    const pizza = await seedPizza();
    const added = await runTool("add_order_item", { productId: pizza.id, variantId: "grande", modifierOptionIds: ["borda"], quantity: 1 }, ctx());

    const updated = await runTool("update_order_item", { itemId: itemIdOf(added.data), quantity: 3, notes: "sem pressa" }, ctx());

    const data = updated.data as { items: { variant: string | null; modifiers: string[]; quantity: number; notes: string | null }[]; totalCents: number };
    expect(data.items[0]).toMatchObject({ variant: "Grande", modifiers: ["Borda recheada"], quantity: 3, notes: "sem pressa" });
    expect(data.totalCents).toBe((4000 + 1500 + 800) * 3);
  });
});

describe("travas contra mutação duplicada", () => {
  it("o mesmo operationId reaplicado não duplica item", async () => {
    const pizza = await seedPizza();
    const args = { productId: pizza.id, quantity: 1, variantId: "media", __operationId: "op-retry" };

    await runTool("add_order_item", { ...args }, ctx());
    await runTool("add_order_item", { ...args }, ctx());

    expect((await getActiveOrder(EST, PHONE))?.items).toHaveLength(1);
  });

  it("operationIds diferentes para o mesmo produto somam — repetição intencional não é retry", async () => {
    const pizza = await seedPizza();

    await runTool("add_order_item", { productId: pizza.id, quantity: 1, variantId: "media", __operationId: "op-1" }, ctx());
    await runTool("add_order_item", { productId: pizza.id, quantity: 1, variantId: "media", __operationId: "op-2" }, ctx());

    expect((await getActiveOrder(EST, PHONE))?.items).toHaveLength(2);
  });

  it("pedido confirmado não aceita nova mutação nem confirmação repetida", async () => {
    const pizza = await seedPizza();
    await saveOrderSettings(EST, { pickupEnabled: true, acceptedPaymentMethods: ["cash"] });
    const added = await runTool("add_order_item", { productId: pizza.id, quantity: 1, variantId: "media" }, ctx());
    await runTool("set_order_fulfillment", { fulfillment: "pickup" }, ctx());
    const ready = await runTool("set_order_payment", { method: "cash" }, ctx());
    const { id, version } = ready.data as { id: string; version: number };

    const first = await runTool("confirm_order", { orderId: id, version }, ctx());
    const again = await runTool("confirm_order", { orderId: id, version }, ctx());
    const mutation = await runTool("update_order_item", { itemId: itemIdOf(added.data), quantity: 5 }, ctx());

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true); // idempotente: devolve o pedido já confirmado
    expect((again.data as { status: string }).status).toBe("confirmed");
    expect(mutation.ok).toBe(false);
  });
});

describe("fallback quando o loop de ferramentas estoura", () => {
  it("com pedido em andamento, responde com o carrinho real em vez de transferir", () => {
    const reply = composeOrderReply({ status: "draft", items: [{ name: "Pizza Calabresa", quantity: 1, variant: "Grande" }], totalCents: 5500 });

    expect(reply).toContain("1x Pizza Calabresa (Grande)");
    expect(reply).toContain("R$");
    expect(reply).toMatch(/adicionar mais|fechar/i);
  });

  it("com pedido já confirmado, conta a confirmação — nunca deixa o cliente sem saber", () => {
    const reply = composeOrderReply({ status: "confirmed", items: [{ name: "Pizza Calabresa", quantity: 2 }], totalCents: 8000 });

    expect(reply).toMatch(/confirmado/i);
    expect(reply).toContain("2x Pizza Calabresa");
  });

  it("sem item nenhum não inventa pedido — deixa o fluxo seguir para o handoff", () => {
    expect(composeOrderReply({ status: "draft", items: [], totalCents: 0 })).toBeNull();
    expect(composeOrderReply({})).toBeNull();
  });
});

describe("garantias da F3 preservadas", () => {
  it("trocar composição não muda o estado do pagamento nem confirma pix", async () => {
    const pizza = await seedPizza();
    await saveOrderSettings(EST, { pickupEnabled: true, acceptedPaymentMethods: ["pix"], pixInstructions: "Chave PIX: 14999998888" });
    const added = await runTool("add_order_item", { productId: pizza.id, variantId: "media", quantity: 1 }, ctx());
    await runTool("set_order_fulfillment", { fulfillment: "pickup" }, ctx());
    await runTool("set_order_payment", { method: "pix" }, ctx());

    await runTool("update_order_item", { itemId: itemIdOf(added.data), variantId: "grande" }, ctx());
    const draft = await runTool("get_order_draft", {}, ctx());

    const data = draft.data as { payment: { method: string; status: string }; pixInstructions?: string; totalCents: number };
    expect(data.payment).toMatchObject({ method: "pix", status: "pending" });
    expect(data.pixInstructions).toBe("Chave PIX: 14999998888");
    expect(data.totalCents).toBe(5500);
  });
});
