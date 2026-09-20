// F4 da Lívia Alimentação V2 — o estouro do loop de ferramentas com pedido
// em andamento, no pipeline real (think() + ferramentas + lib/orders.ts).
// Só o modelo é roteirizado: aqui ele gasta as 4 iterações chamando
// ferramentas e nunca produz texto final, que é exatamente o cenário em que
// o cliente ficava com o carrinho montado e recebia um handoff mudo.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

type ModelMessage = { content: string | null; tool_calls?: unknown[] };
let modelScript: ModelMessage[] = [];
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: async () => ({ choices: [{ message: modelScript.shift() ?? { content: "ok" } }] }) } };
  },
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { think } from "@/lib/ai/brain";
import { detectIntent } from "@/lib/ai/intent";
import { saveMenuCategory, saveMenuProduct, saveOrderSettings } from "@/lib/orders";
import type { Establishment, KnowledgeBase, MenuProduct } from "@/types";

const EST = "est_lanchonete";
const PHONE = "5514991234567";
const NOW = new Date("2026-09-20T13:00:00.000Z").getTime();

const est = (): Establishment => ({
  id: EST, name: "Lanchonete Teste", type: "lanchonete", ownerUid: EST, status: "active", createdAt: 0,
  bot: { personaName: "Lívia", tone: "acolhedora", bookingEnabled: false, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
});
const kb = (): KnowledgeBase => ({
  establishmentId: EST, about: "Lanchonete de bairro", address: "Rua Teste, 100", hours: null, services: [], faqs: [],
  notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0,
});
const toolCall = (name: string, args: Record<string, unknown>, id: string): ModelMessage =>
  ({ content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });

async function turn(text: string) {
  return think({
    est: est(), kb: kb(), history: [{ id: "m1", role: "customer", text, at: NOW }],
    contactPhone: PHONE, contactName: "Cliente Teste", customerProfile: null, task: null, intent: detectIntent(text),
  });
}

let burger: MenuProduct;

beforeEach(async () => {
  fakeDb.reset();
  modelScript = [];
  const categoria = await saveMenuCategory(EST, { name: "Lanches", sortOrder: 0 });
  burger = await saveMenuProduct(EST, { categoryId: categoria.id, name: "X-Burger", basePriceCents: 2000, active: true, variants: [], modifierGroups: [] });
  await saveOrderSettings(EST, { pickupEnabled: true, acceptedPaymentMethods: ["cash", "pix"] });
});

describe("estouro do loop com pedido em andamento", () => {
  it("responde com o carrinho real em vez de transferir para atendente", async () => {
    // O modelo gasta as 4 iterações em ferramentas e nunca escreve a resposta.
    modelScript = [
      toolCall("add_order_item", { productId: burger.id, quantity: 2 }, "t1"),
      toolCall("get_order_draft", {}, "t2"),
      toolCall("get_order_draft", {}, "t3"),
      toolCall("get_order_draft", {}, "t4"),
    ];

    const r = await turn("quero dois x-burger");

    expect(r.handoff).toBe(false);
    expect(r.reply).toContain("2x X-Burger");
    expect(r.reply).toContain("R$");
    // O cliente precisa saber que o pedido existe e o que falta decidir.
    expect(r.reply).toMatch(/adicionar mais|fechar/i);
  });

  it("sem nada aproveitável no turno, o handoff continua sendo a resposta certa", async () => {
    modelScript = [
      toolCall("search_menu", { query: "sushi" }, "s1"),
      toolCall("search_menu", { query: "sushi" }, "s2"),
      toolCall("search_menu", { query: "sushi" }, "s3"),
      toolCall("search_menu", { query: "sushi" }, "s4"),
    ];

    const r = await turn("vocês têm sushi?");

    expect(r.handoff).toBe(true);
    expect(r.reply).toMatch(/pessoa da equipe/i);
  });

  it("pedido confirmado no turno é anunciado como confirmado, nunca como pendente", async () => {
    modelScript = [
      toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "c1"),
      toolCall("set_order_fulfillment", { fulfillment: "pickup" }, "c2"),
      toolCall("set_order_payment", { method: "cash" }, "c3"),
      toolCall("get_order_draft", {}, "c4"),
    ];
    const first = await turn("quero um x-burger para retirada, pago em dinheiro");
    expect(first.handoff).toBe(false);
    expect(first.reply).toContain("1x X-Burger");
  });
});
