// F3 da Lívia Alimentação V2 — o que a IA passa a enxergar na conversa de
// pedido: cardápio inteiro, instruções de PIX e item repetido no resumo.
//
// Exercita as ferramentas reais (runTool + lib/orders.ts) contra o
// firestoreFake, sem mockar nenhuma delas — mesmo padrão de
// lib/orders.categoryAvailability.test.ts.
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
import { runTool, toolsFor, type ToolContext } from "@/lib/ai/tools";
import { saveMenuCategory, saveMenuProduct, saveOrderSettings } from "@/lib/orders";
import type { Establishment } from "@/types";

const EST = "est-lanchonete";
const PHONE = "5514991234567";

function establishment(ordersEnabled = true): Establishment {
  return {
    id: EST, name: "Lanchonete Teste", type: "lanchonete", ownerUid: EST, status: "active", createdAt: 0,
    bot: { personaName: "Lívia", tone: "acolhedora", bookingEnabled: false, ordersEnabled, handoffKeywords: [], medicalGuardrail: false },
  };
}
const ctx = (ordersEnabled = true): ToolContext => ({
  est: establishment(ordersEnabled), kb: null, config: null, contactPhone: PHONE, contactName: "Cliente", offset: -180, customerProfile: null,
});

beforeEach(() => {
  fakeDb.reset();
});

async function seedMenu() {
  const burgers = await saveMenuCategory(EST, { name: "Hambúrgueres", sortOrder: 0 });
  const bebidas = await saveMenuCategory(EST, { name: "Bebidas", sortOrder: 1 });
  const xburger = await saveMenuProduct(EST, {
    categoryId: burgers.id, name: "X-Burger", description: "Pão, carne 180g, queijo", basePriceCents: 2000, active: true,
    variants: [{ id: "duplo", name: "Duplo", priceDeltaCents: 800, active: true }],
    modifierGroups: [{ id: "extra", name: "Adicionais", required: false, minSelections: 0, maxSelections: 2, options: [{ id: "bacon", name: "Bacon", priceDeltaCents: 400, active: true }] }],
  });
  const refri = await saveMenuProduct(EST, { categoryId: bebidas.id, name: "Refrigerante lata", basePriceCents: 600, active: true, variants: [], modifierGroups: [] });
  return { burgers, bebidas, xburger, refri };
}

describe("list_menu", () => {
  it("está disponível para a IA quando pedidos estão ligados", () => {
    expect(toolsFor(ctx()).some((t) => t.function.name === "list_menu")).toBe(true);
    expect(toolsFor(ctx(false)).some((t) => t.function.name === "list_menu")).toBe(false);
  });

  it("devolve o cardápio inteiro agrupado por categoria, sem precisar de busca", async () => {
    await seedMenu();

    const result = await runTool("list_menu", {}, ctx());

    expect(result.ok).toBe(true);
    const data = result.data as { categories: { name: string; products: { name: string; basePriceCents: number; hasVariants: boolean; hasModifiers: boolean }[] }[]; truncated: boolean };
    expect(data.categories.map((c) => c.name)).toEqual(["Hambúrgueres", "Bebidas"]);
    expect(data.truncated).toBe(false);
    const xburger = data.categories[0]!.products[0]!;
    expect(xburger).toMatchObject({ name: "X-Burger", basePriceCents: 2000, hasVariants: true, hasModifiers: true });
    // Bebidas aparece sem ninguém ter perguntado por "refrigerante" — é o
    // ponto da ferramenta: "manda o cardápio" não pode esconder categoria.
    expect(data.categories[1]!.products.map((p) => p.name)).toEqual(["Refrigerante lata"]);
  });

  it("não lista produto desativado nem categoria desativada", async () => {
    const { bebidas, burgers } = await seedMenu();
    await saveMenuProduct(EST, { categoryId: burgers.id, name: "X-Egg (acabou)", basePriceCents: 2200, active: false, variants: [], modifierGroups: [] });
    await saveMenuCategory(EST, { name: bebidas.name, active: false }, bebidas.id);

    const data = (await runTool("list_menu", {}, ctx())).data as { categories: { name: string; products: { name: string }[] }[] };

    expect(data.categories.map((c) => c.name)).toEqual(["Hambúrgueres"]);
    expect(data.categories[0]!.products.map((p) => p.name)).toEqual(["X-Burger"]);
  });

  it("cardápio grande é cortado com aviso, em vez de despejar tudo na conversa", async () => {
    const categoria = await saveMenuCategory(EST, { name: "Tudo", sortOrder: 0 });
    for (let i = 0; i < 65; i++) {
      await saveMenuProduct(EST, { categoryId: categoria.id, name: `Item ${String(i).padStart(2, "0")}`, basePriceCents: 1000, active: true, variants: [], modifierGroups: [] });
    }

    const data = (await runTool("list_menu", {}, ctx())).data as { categories: { products: unknown[] }[]; truncated: boolean };

    expect(data.categories[0]!.products).toHaveLength(60);
    expect(data.truncated).toBe(true);
  });
});

describe("instruções de PIX chegando à Livia", () => {
  it("vêm no resumo assim que o cliente escolhe pix", async () => {
    const { xburger } = await seedMenu();
    await saveOrderSettings(EST, { pickupEnabled: true, acceptedPaymentMethods: ["pix", "cash"], pixInstructions: "Chave PIX: 14999998888 — Lanchonete Teste" });
    await runTool("add_order_item", { productId: xburger.id, quantity: 1 }, ctx());
    await runTool("set_order_fulfillment", { fulfillment: "pickup" }, ctx());

    const result = await runTool("set_order_payment", { method: "pix" }, ctx());

    expect((result.data as { pixInstructions?: string }).pixInstructions).toBe("Chave PIX: 14999998888 — Lanchonete Teste");
  });

  it("continuam disponíveis quando a Livia relê o resumo do pedido", async () => {
    const { xburger } = await seedMenu();
    await saveOrderSettings(EST, { pickupEnabled: true, acceptedPaymentMethods: ["pix"], pixInstructions: "Chave PIX: 14999998888" });
    await runTool("add_order_item", { productId: xburger.id, quantity: 1 }, ctx());
    await runTool("set_order_fulfillment", { fulfillment: "pickup" }, ctx());
    await runTool("set_order_payment", { method: "pix" }, ctx());

    const result = await runTool("get_order_draft", {}, ctx());

    expect((result.data as { pixInstructions?: string }).pixInstructions).toBe("Chave PIX: 14999998888");
  });

  it("não aparecem em pagamento que não é pix", async () => {
    const { xburger } = await seedMenu();
    await saveOrderSettings(EST, { pickupEnabled: true, acceptedPaymentMethods: ["pix", "cash"], pixInstructions: "Chave PIX: 14999998888" });
    await runTool("add_order_item", { productId: xburger.id, quantity: 1 }, ctx());
    await runTool("set_order_fulfillment", { fulfillment: "pickup" }, ctx());

    const result = await runTool("set_order_payment", { method: "cash" }, ctx());

    expect((result.data as { pixInstructions?: string }).pixInstructions).toBeUndefined();
  });

  it("estabelecimento sem instruções cadastradas não inventa nada", async () => {
    const { xburger } = await seedMenu();
    await saveOrderSettings(EST, { pickupEnabled: true, acceptedPaymentMethods: ["pix"], pixInstructions: null });
    await runTool("add_order_item", { productId: xburger.id, quantity: 1 }, ctx());
    await runTool("set_order_fulfillment", { fulfillment: "pickup" }, ctx());

    const result = await runTool("set_order_payment", { method: "pix" }, ctx());

    expect((result.data as { pixInstructions?: string }).pixInstructions).toBeUndefined();
    // O estado do pagamento continua pendente: instrução é texto, não baixa.
    expect((result.data as { payment: { status: string } }).payment.status).toBe("pending");
  });
});

describe("item repetido no resumo", () => {
  it("marca as duas linhas quando o mesmo produto entra duas vezes igual", async () => {
    const { xburger } = await seedMenu();
    await runTool("add_order_item", { productId: xburger.id, quantity: 1 }, ctx());

    const result = await runTool("add_order_item", { productId: xburger.id, quantity: 1 }, ctx());

    const items = (result.data as { items: { name: string; repeatedProduct: boolean }[] }).items;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.repeatedProduct)).toBe(true);
  });

  it("não marca quando muda a variação ou os adicionais", async () => {
    const { xburger } = await seedMenu();
    await runTool("add_order_item", { productId: xburger.id, quantity: 1 }, ctx());

    const result = await runTool("add_order_item", { productId: xburger.id, variantId: "duplo", quantity: 1 }, ctx());

    const items = (result.data as { items: { repeatedProduct: boolean }[] }).items;
    expect(items.every((i) => i.repeatedProduct === false)).toBe(true);
  });

  it("não marca produtos diferentes", async () => {
    const { xburger, refri } = await seedMenu();
    await runTool("add_order_item", { productId: xburger.id, quantity: 1 }, ctx());

    const result = await runTool("add_order_item", { productId: refri.id, quantity: 2 }, ctx());

    const items = (result.data as { items: { repeatedProduct: boolean }[] }).items;
    expect(items.every((i) => i.repeatedProduct === false)).toBe(true);
  });
});
