// F5.5 — quando o prospect inicia um pedido REAL durante a demonstração de
// restaurante ("quero uma coca lata 350ml e x-burger"), a Lívia precisa
// concluir esse pedido pelo MESMO fluxo/tools reais da vertical Alimentação
// (retirada/entrega, endereço, pagamento, resumo canônico, confirmação) em
// vez de reverter para o discurso comercial assim que o cliente responde uma
// pergunta do próprio pedido ("não" ao adicional).
//
// Mesmo padrão de integração real de lib/ai/ordersConversation.test.ts
// (think() + toolsFor/runTool + lib/orders.ts reais) combinado com o
// contexto comercial/demo de lib/ai/commercialDemoIntegration.test.ts: só
// @/lib/firebase/admin (firestoreFake) e @/lib/ai/gateway (runCompletion) são
// roteirizados — nenhuma tool, nenhuma função de lib/orders.ts é substituída.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ConversationContext, ConversationTask, Establishment, KnowledgeBase, Message } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

type ModelMessage = { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
let modelScript: ModelMessage[] = [];
let completionInput: { messages: OpenAI.Chat.ChatCompletionMessageParam[] } | null = null;
vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: typeof completionInput) => {
    completionInput = input;
    return modelScript.shift() ?? { content: "Anotado!", tool_calls: undefined };
  }),
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { seedDemoCatalog } from "@/lib/demo/catalog";
import { capabilitiesForConversation } from "./conversationPolicy";
import { think } from "./brain";
import { getActiveOrder, getOrder, listOrders } from "@/lib/orders";

const EST = "demo-order-completion";
const LEAD = "lead-demo-order";
const PHONE = "5511900000099";
const NOW = new Date("2026-10-05T17:00:00.000Z");

const est: Establishment = {
  id: EST,
  name: "Lanchonete Demo",
  type: "restaurante",
  ownerUid: EST,
  status: "active",
  createdAt: 0,
  demoChannel: { enabled: true },
  bot: { personaName: "Lívia", tone: "objetiva", bookingEnabled: false, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const kb: KnowledgeBase = {
  establishmentId: EST, about: "Lanchonete fictícia", address: null, hours: "9h às 22h",
  services: [], faqs: [], notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0,
};

const prospectingContext = () => ({ status: "INTERESTED", leadId: LEAD, segment: "restaurant" }) as never;
const authorization = () => ({ authorized: true as const, establishmentId: EST, prospectingLeadId: LEAD });

function commercialContext(): ConversationContext {
  return { purpose: "commercial", source: "prospecting", enteredAt: 100, updatedAt: 100, commercial: { segment: "restaurant", segmentIdentifiedAt: 100 } };
}

const toolCall = (name: string, args: Record<string, unknown>, id = `c-${name}-${Math.random().toString(36).slice(2, 6)}`): ModelMessage => ({ content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const toolBatch = (...calls: { name: string; args: Record<string, unknown>; id?: string }[]): ModelMessage => ({ content: null, tool_calls: calls.map(({ name, args, id }) => ({ id: id ?? `c-${name}-${Math.random().toString(36).slice(2, 6)}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })) });
const say = (text: string): ModelMessage => ({ content: text });

function systemContent(): string {
  return String((completionInput?.messages ?? []).find((m) => m.role === "system")?.content ?? "");
}

async function turn(text: string, history: Message[], task: ConversationTask | null) {
  const context = commercialContext();
  const demoAuthorization = authorization();
  const capabilities = capabilitiesForConversation({ context, bookingEnabled: false, ordersEnabled: true, demoAuthorized: true });
  const historyForAI: Message[] = [...history, { id: `c${history.length}`, role: "customer", text, at: NOW.getTime() }];
  const currentOrder = await getActiveOrder(EST, PHONE);
  const r = await think({
    est, kb,
    history: historyForAI,
    contactPhone: PHONE, contactName: "Prospect", customerProfile: null, task,
    intent: { type: "general_question", confidence: 0.5, entities: {} },
    prospectingContext: prospectingContext(),
    demoAuthorization,
    conversationContext: context,
    capabilities,
    orderAwaitingConfirmation: currentOrder?.status === "awaiting_confirmation" ? { orderId: currentOrder.id, version: currentOrder.version } : null,
  });
  history.push({ id: `c${history.length}`, role: "customer", text, at: NOW.getTime() });
  history.push({ id: `b${history.length}`, role: "bot", text: r.reply, at: NOW.getTime() });
  return { result: r, history, task: null as ConversationTask | null };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  modelScript = [];
  completionInput = null;
  fakeDb.reset();
  fakeDb.col("establishments").set(EST, { id: EST, bot: { bookingEnabled: false, ordersEnabled: true } });
  fakeDb.col(`establishments/${EST}/conversations`).set(PHONE, { id: PHONE });
  await seedDemoCatalog(EST);
});

afterEach(() => vi.useRealTimers());

describe("F5.5 — pedido real inicia dentro da demonstração e a Lívia o conclui", () => {
  it("'quero uma coca lata 350ml e x-burger' adiciona os itens reais do catálogo demo com total correto", async () => {
    modelScript = [
      toolBatch(
        { name: "add_order_item", args: { productId: "demo-prod-coca", variantId: "demo-var-coca-lata", quantity: 1, __allowDraftCreation: true } },
        { name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true } },
      ),
      say("Beleza! 1 Coca-Cola Lata 350ml e 1 X-Burger, total R$ 32,00. Quer algum adicional no X-Burger, tipo bacon extra?"),
    ];
    const t1 = await turn("quero uma coca lata 350ml e x-burger", [], null);

    expect(t1.result.toolCalls.map((c) => c.name)).toEqual(["add_order_item", "add_order_item"]);
    const order = await getActiveOrder(EST, PHONE);
    expect(order).toMatchObject({ mode: "demo", prospectingLeadId: LEAD, status: "draft" });
    expect(order?.items).toHaveLength(2);
    expect(order?.totalCents).toBe(3200);
    // Ainda não havia pedido aberto ANTES deste turno — a orientação de
    // prioridade só entra a partir do próximo turno, quando já existe carrinho.
    expect(systemContent()).not.toContain("PEDIDO DEMO EM ANDAMENTO");
  });

  it("'não' ao adicional NÃO sai para discurso comercial: o prompt prioriza concluir o pedido, não apresentar a Lívia", async () => {
    modelScript = [
      toolBatch(
        { name: "add_order_item", args: { productId: "demo-prod-coca", variantId: "demo-var-coca-lata", quantity: 1, __allowDraftCreation: true } },
        { name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true } },
      ),
      say("Total R$ 32,00. Quer algum adicional no X-Burger?"),
    ];
    const t1 = await turn("quero uma coca lata 350ml e x-burger", [], null);

    modelScript = [say("Perfeito, sem adicionais. Vai ser para retirada ou entrega?")];
    const t2 = await turn("não", t1.history, t1.task);

    // A causa raiz do F5.5: com um pedido em aberto, o prompt precisa
    // conter a seção de prioridade e NÃO pode reverter para a oferta
    // comercial ("quer que eu explique como ela funciona").
    const prompt2 = systemContent();
    expect(prompt2).toContain("PEDIDO DEMO EM ANDAMENTO");
    expect(prompt2).toContain("NÃO pergunte se a pessoa quer que você explique como a Lívia funciona");
    expect(t2.result.toolCalls.map((c) => c.name)).toContain("get_order_draft");
    expect(t2.result.reply).not.toMatch(/pode montar pedidos|quer que eu explique/i);

    // O pedido continua intacto — "não" não encerrou nem esvaziou o carrinho.
    const order = await getActiveOrder(EST, PHONE);
    expect(order?.items).toHaveLength(2);
    expect(order?.status).toBe("draft");
  });

  it("cadeia completa: entrega → endereço → pagamento → resumo canônico → confirmação registra o pedido demo", async () => {
    modelScript = [
      toolBatch(
        { name: "add_order_item", args: { productId: "demo-prod-coca", variantId: "demo-var-coca-lata", quantity: 1, __allowDraftCreation: true } },
        { name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true } },
      ),
      say("Total R$ 32,00. Quer algum adicional no X-Burger?"),
    ];
    const t1 = await turn("quero uma coca lata 350ml e x-burger", [], null);

    modelScript = [say("Perfeito, sem adicionais. Vai ser para retirada ou entrega?")];
    const t2 = await turn("não", t1.history, t1.task);

    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "delivery" }), say("Qual o endereço de entrega?")];
    const t3 = await turn("entrega", t2.history, t2.task);
    expect((await getActiveOrder(EST, PHONE))?.fulfillment).toBe("delivery");

    modelScript = [toolCall("set_order_address", { raw: "Rua das Flores, 123", neighborhood: "Centro" }), say("Endereço registrado. Como vai pagar: pix, dinheiro ou cartão?")];
    const t4 = await turn("Rua das Flores, 123, bairro Centro", t3.history, t3.task);
    const afterAddress = await getActiveOrder(EST, PHONE);
    expect(afterAddress?.deliveryAddress).toMatchObject({ raw: "Rua das Flores, 123", neighborhood: "Centro" });
    expect(afterAddress?.deliveryFeeCents).toBe(500);
    expect(afterAddress?.totalCents).toBe(3700);

    modelScript = [toolCall("set_order_payment", { method: "pix" }), say("Pagamento via Pix, combinado.")];
    const t5 = await turn("pix", t4.history, t4.task);
    expect((await getActiveOrder(EST, PHONE))?.payment).toMatchObject({ method: "pix", status: "pending" });

    modelScript = [toolCall("prepare_order_confirmation", {})];
    const t6 = await turn("pode confirmar?", t5.history, t5.task);
    // Resumo canônico curto-circuitado por think() (composeOrderConfirmationRequest).
    expect(t6.result.reply).toContain("Confira seu pedido");
    expect(t6.result.reply).toContain("Total:");
    const awaiting = await getActiveOrder(EST, PHONE);
    expect(awaiting?.status).toBe("awaiting_confirmation");

    modelScript = [toolCall("confirm_order", { orderId: awaiting!.id, version: awaiting!.version })];
    const t7 = await turn("confirmo", t6.history, t6.task);
    expect(t7.result.reply).toContain("Pedido registrado no sistema");
    expect(t7.result.reply).toContain("demonstrativo");

    const confirmed = await getOrder(EST, awaiting!.id);
    expect(confirmed).toMatchObject({ status: "confirmed", mode: "demo", prospectingLeadId: LEAD });
    expect(await getActiveOrder(EST, PHONE)).toBeNull();
    // Isolamento F2 preservado: pedido demo nunca aparece na operação real.
    expect(await listOrders(EST)).toEqual([]);
  });

  it("'retirada' NÃO pede endereço de entrega e segue direto para pagamento", async () => {
    modelScript = [
      toolBatch(
        { name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true } },
      ),
      say("1 X-Burger, R$ 24,00. Quer algum adicional?"),
    ];
    const t1 = await turn("quero um x-burger", [], null);

    modelScript = [say("Combinado, sem adicionais. Retirada ou entrega?")];
    const t2 = await turn("não", t1.history, t1.task);

    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "pickup" }), say("Combinado, retirada no local. Como vai pagar?")];
    const t3 = await turn("retirada", t2.history, t2.task);

    const order = await getActiveOrder(EST, PHONE);
    expect(order?.fulfillment).toBe("pickup");
    expect(order?.deliveryAddress).toBeNull();
    expect(order?.deliveryFeeCents).toBe(0);
    expect(order?.totalCents).toBe(2400);
    expect(t3.result.toolCalls.map((c) => c.name)).not.toContain("set_order_address");
    expect(t3.result.reply).not.toMatch(/endereço/i);
  });
});
