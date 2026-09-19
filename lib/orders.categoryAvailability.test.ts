// F1 da Lívia Alimentação V2 — categoria desativada tira do ar os produtos
// dela. Antes desta fase só `product.active` era checado: o comerciante
// desativava "Sobremesas" porque acabou o sorvete e a Livia continuava
// vendendo cada sobremesa individualmente.
//
// Usa o firestoreFake (mesmo harness de orders.concurrency.test.ts) para
// exercitar os caminhos reais de lib/orders.ts, inclusive a transação de
// confirmação.
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
  categoryBlocksSale,
  confirmOrder,
  getAvailableMenuProduct,
  listAvailableMenuProducts,
  saveMenuCategory,
  saveMenuProduct,
  setOrderFulfillment,
  setOrderPayment,
} from "@/lib/orders";

const EST = "est-1";
const PHONE = "5511999990000";
const CONV = PHONE;
const NAME = "Cliente Teste";

beforeEach(() => {
  fakeDb.reset();
});

async function seedCategoryAndProduct(active: boolean) {
  const category = await saveMenuCategory(EST, { name: "Sobremesas", active });
  const product = await saveMenuProduct(EST, {
    categoryId: category.id,
    name: "Pudim",
    basePriceCents: 1200,
    active: true,
    variants: [],
    modifierGroups: [],
  });
  return { category, product };
}

describe("disponibilidade por categoria", () => {
  it("categoria ativa: produto continua vendável", async () => {
    const { product } = await seedCategoryAndProduct(true);

    const order = await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1);

    expect(order.items).toHaveLength(1);
    expect(order.totalCents).toBe(1200);
  });

  it("categoria desativada bloqueia adicionar o produto ao pedido", async () => {
    const { product } = await seedCategoryAndProduct(false);

    await expect(addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1)).rejects.toThrow(/indisponível/i);
  });

  it("categoria desativada some da busca e da consulta usadas pela IA", async () => {
    const { product } = await seedCategoryAndProduct(false);

    expect(await listAvailableMenuProducts(EST)).toHaveLength(0);
    expect(await getAvailableMenuProduct(EST, product.id)).toBeNull();
  });

  it("categoria ativa aparece na visão da IA; produto desativado continua fora", async () => {
    const { category, product } = await seedCategoryAndProduct(true);
    const inativo = await saveMenuProduct(EST, { categoryId: category.id, name: "Mousse", basePriceCents: 900, active: false, variants: [], modifierGroups: [] });

    const disponiveis = await listAvailableMenuProducts(EST);

    expect(disponiveis.map((p) => p.id)).toEqual([product.id]);
    expect(await getAvailableMenuProduct(EST, inativo.id)).toBeNull();
  });

  it("desativar a categoria entre o rascunho e a confirmação impede confirmar", async () => {
    const { category, product } = await seedCategoryAndProduct(true);
    await addOrderItem(EST, CONV, PHONE, NAME, product.id, null, [], 1);
    await setOrderFulfillment(EST, CONV, PHONE, NAME, "pickup");
    const ready = await setOrderPayment(EST, CONV, PHONE, NAME, "cash");

    await saveMenuCategory(EST, { name: category.name, active: false }, category.id);

    await expect(confirmOrder(EST, ready.id, ready.version, PHONE)).rejects.toThrow(/não está mais disponível/i);
  });

  it("produto órfão (categoria inexistente) mantém o comportamento antigo", async () => {
    // Catálogo legado, ou categoria removida fora do painel: a correção não
    // pode derrubar venda de item que hoje funciona.
    const orfao = await saveMenuProduct(EST, { categoryId: "categoria-que-nao-existe", name: "X-Burger", basePriceCents: 2000, active: true, variants: [], modifierGroups: [] });

    const order = await addOrderItem(EST, CONV, PHONE, NAME, orfao.id, null, [], 1);

    expect(order.items).toHaveLength(1);
    expect(await getAvailableMenuProduct(EST, orfao.id)).not.toBeNull();
  });

  it("categoryBlocksSale só bloqueia categoria explicitamente desativada", () => {
    expect(categoryBlocksSale(null)).toBe(false);
    expect(categoryBlocksSale(undefined)).toBe(false);
    expect(categoryBlocksSale({ id: "c", name: "Bebidas", active: true, sortOrder: 0, createdAt: 0, updatedAt: 0 })).toBe(false);
    expect(categoryBlocksSale({ id: "c", name: "Bebidas", active: false, sortOrder: 0, createdAt: 0, updatedAt: 0 })).toBe(true);
  });
});
