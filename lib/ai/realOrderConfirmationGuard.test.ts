// Comercial Real (estabelecimento cliente, contexto operational): a proteção
// F5.6 (claimsOrderConfirmed) precisa valer para pedido REAL, não só para a
// demo — e nenhuma linguagem de demonstração pode aparecer para o consumidor.
//
// Mesmo harness de integração de demoOrderPaymentConfirmation.test.ts: think()
// + tools + lib/orders.ts reais sobre o Firestore fake; só o modelo é
// roteirizado. O cardápio é cadastrado pelas mesmas funções do painel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ConversationContext, Establishment, KnowledgeBase, Message } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

type ModelMessage = { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
let script: ModelMessage[] = [];
let lastInput: { messages: OpenAI.Chat.ChatCompletionMessageParam[] } | null = null;
vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: typeof lastInput) => {
    lastInput = input;
    return script.shift() ?? { content: "Anotado!" };
  }),
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { seedDemoCatalog } from "@/lib/demo/catalog";
import { capabilitiesForConversation } from "./conversationPolicy";
import { claimsOrderConfirmed, think } from "./brain";
import { getActiveOrder, getOrder, listOrders } from "@/lib/orders";

const EST = "lanchonete-cliente-real";
const OTHER = "outro-cliente-real";
const PHONE = "5511955550001";
const NOW = new Date("2026-10-05T17:00:00.000Z");

const est = {
  id: EST, name: "Lanchonete do Bairro", type: "restaurante", ownerUid: EST, status: "active", createdAt: 0,
  bot: { personaName: "Lívia", tone: "objetiva", bookingEnabled: false, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const kb: KnowledgeBase = {
  establishmentId: EST, about: "Lanchonete de bairro", address: "Rua A, 1", hours: "9h às 22h",
  services: [], faqs: [], notes: null, paymentMethods: "Pix, dinheiro e cartão", importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0,
};
const operational: ConversationContext = { purpose: "operational", source: "normal", enteredAt: 0, updatedAt: 0 };

const call = (name: string, args: Record<string, unknown>): ModelMessage => ({ content: null, tool_calls: [{ id: `c-${name}-${Math.random().toString(36).slice(2, 6)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const say = (content: string): ModelMessage => ({ content });
const systemMessages = () => (lastInput?.messages ?? []).filter((m) => m.role === "system").map((m) => String(m.content));

async function turn(text: string, history: Message[]) {
  const capabilities = capabilitiesForConversation({ context: operational, bookingEnabled: false, ordersEnabled: true, demoAuthorized: false });
  const current = await getActiveOrder(EST, PHONE);
  const result = await think({
    est, kb, history: [...history, { id: `c${history.length}`, role: "customer", text, at: NOW.getTime() }],
    contactPhone: PHONE, contactName: "Consumidor", customerProfile: null, task: null,
    intent: { type: "general_question", confidence: 0.5, entities: {} },
    conversationContext: operational, capabilities,
    orderAwaitingConfirmation: current?.status === "awaiting_confirmation" ? { orderId: current.id, version: current.version } : null,
  });
  history.push({ id: `c${history.length}`, role: "customer", text, at: NOW.getTime() }, { id: `b${history.length}`, role: "bot", text: result.reply, at: NOW.getTime() });
  return result;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  script = [];
  lastInput = null;
  fakeDb.reset();
  fakeDb.col("establishments").set(EST, { id: EST, bot: { bookingEnabled: false, ordersEnabled: true } });
  fakeDb.col("establishments").set(OTHER, { id: OTHER, bot: { bookingEnabled: false, ordersEnabled: true } });
  await seedDemoCatalog(EST);
});
afterEach(() => vi.useRealTimers());

describe("C — pedido real: F5.6 vale fora da demo", () => {
  it("C5: sem pagamento, 'pedido confirmado' em texto livre é interceptado e o pedido real continua em draft", async () => {
    const history: Message[] = [];
    script = [call("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }), say("X-Burger anotado. Retirada ou entrega?")];
    await turn("quero um x-burger", history);
    script = [call("set_order_fulfillment", { fulfillment: "pickup" }), say("Retirada, combinado.")];
    await turn("retirada", history);

    script = [say("Pronto, seu pedido está confirmado!"), say("Falta a forma de pagamento: pix, dinheiro ou cartão?")];
    const result = await turn("sim", history);

    expect(result.toolCalls.map((c) => c.name)).not.toContain("confirm_order");
    expect(claimsOrderConfirmed(result.reply)).toBe(false);
    expect(systemMessages().join("\n")).toContain("confirm_order NÃO foi executado com sucesso");
    const order = await getActiveOrder(EST, PHONE);
    expect(order).toMatchObject({ status: "draft" });
    expect(order?.mode).toBeUndefined();
    expect(await listOrders(EST)).toEqual([]);
  });

  it("C5: pagamento definido mas sem resumo canônico — 'sim' prematuro não fecha nem é anunciado", async () => {
    const history: Message[] = [];
    script = [call("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }), say("Anotado.")];
    await turn("quero um x-burger", history);
    script = [call("set_order_fulfillment", { fulfillment: "pickup" }), say("Retirada.")];
    await turn("retirada", history);
    script = [call("set_order_payment", { method: "cash" }), say("Dinheiro, ok.")];
    await turn("dinheiro", history);

    script = [call("confirm_order", { orderId: "forjado", version: 1 }), say("Pedido confirmado e enviado para a cozinha!"), say("Vou te mostrar o resumo antes de fechar.")];
    const result = await turn("sim", history);

    expect(claimsOrderConfirmed(result.reply)).toBe(false);
    expect((await getActiveOrder(EST, PHONE))?.status).toBe("draft");
    expect(await listOrders(EST)).toEqual([]);
  });

  it("C4/C6/C11: fluxo real completo confirma pelo backend, entra na operação real e não usa linguagem de demonstração", async () => {
    const history: Message[] = [];
    script = [call("add_order_item", { productId: "demo-prod-coca", variantId: "demo-var-coca-lata", quantity: 2, __allowDraftCreation: true }), say("2 Coca-Cola lata. Retirada ou entrega?")];
    await turn("2 coca lata", history);
    script = [call("set_order_fulfillment", { fulfillment: "delivery" }), say("Qual o endereço?")];
    await turn("entrega", history);
    script = [call("set_order_address", { raw: "Rua B, 20", neighborhood: "Centro" }), say("Como vai pagar?")];
    await turn("Rua B, 20, Centro", history);
    script = [call("set_order_payment", { method: "pix" }), call("prepare_order_confirmation", {})];
    const summary = await turn("pix", history);
    expect(summary.reply).toContain("Confira seu pedido");

    const awaiting = await getActiveOrder(EST, PHONE);
    expect(awaiting?.status).toBe("awaiting_confirmation");
    script = [call("confirm_order", { orderId: awaiting!.id, version: awaiting!.version }), say("Pedido confirmado! Já vai para a cozinha.")];
    const confirmed = await turn("sim", history);

    expect(confirmed.toolCalls.map((c) => c.name)).toContain("confirm_order");
    expect(confirmed.reply).toBe("Pedido confirmado! Já vai para a cozinha.");
    const order = await getOrder(EST, awaiting!.id);
    expect(order).toMatchObject({ status: "confirmed" });
    expect(order?.mode).toBeUndefined();
    expect((await listOrders(EST)).map((o) => o.id)).toEqual([awaiting!.id]);

    for (const message of history.filter((m) => m.role === "bot")) {
      expect(message.text).not.toMatch(/demonstra|fict[íi]cio|conhecer a L[íi]via|ConectWeb/i);
    }
    const prompt = String(lastInput?.messages.find((m) => m.role === "system")?.content ?? "");
    expect(prompt).toContain('a atendente virtual de "Lanchonete do Bairro"');
    expect(prompt).not.toContain("FONTE COMERCIAL CANÔNICA DA LÍVIA");
  });

  it("C9: pedido de um estabelecimento não aparece em outro", async () => {
    const history: Message[] = [];
    script = [call("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }), say("Anotado.")];
    await turn("quero um x-burger", history);
    expect(await getActiveOrder(EST, PHONE)).not.toBeNull();
    expect(await getActiveOrder(OTHER, PHONE)).toBeNull();
    expect(await listOrders(OTHER)).toEqual([]);
  });
});
