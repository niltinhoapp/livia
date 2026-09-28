// F5.6 — a demonstração de restaurante não pode pular pagamento, resumo
// canônico ou confirmação explícita do pedido real.
//
// Diagnóstico (transcript real pós-F5.5, ver PR): o carrinho, a entrega e o
// endereço eram coletados corretamente pelas tools reais, mas a partir daí a
// Lívia perguntava "posso confirmar o pedido?" sem nunca ter chamado
// set_order_payment nem prepare_order_confirmation, e ao "sim" do cliente
// respondia "O pedido ficou confirmado..." como TEXTO LIVRE — nenhuma tool de
// pedido rodou. O backend (lib/orders.ts) já impedia a MUTAÇÃO indevida
// (confirm_order exige awaiting_confirmation vindo de um
// prepare_order_confirmation real, que por sua vez exige pagamento definido);
// faltava impedir a MENTIRA correspondente chegar ao cliente.
//
// Este arquivo cobre a trava nova (claimsOrderConfirmed em lib/ai/brain.ts)
// e a cadeia real de conclusão do pedido (itens → entrega/retirada →
// endereço quando aplicável → pagamento → prepare_order_confirmation →
// confirmação explícita → confirm_order), pelas MESMAS tools/regras da
// vertical Alimentação — nenhum estado paralelo, nenhum hardcode de produto.
//
// Mesmo padrão de integração real de lib/ai/demoOrderCompletion.test.ts
// (think() + tools reais + Firestore fake; só @/lib/firebase/admin e
// @/lib/ai/gateway são roteirizados).
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
import { think, claimsOrderConfirmed } from "./brain";
import { getActiveOrder, getOrder, listOrders } from "@/lib/orders";

const EST = "demo-f56-payment-confirmation";
const LEAD = "lead-f56-payment-confirmation";
const NOW = new Date("2026-10-05T17:00:00.000Z");

const est: Establishment = {
  id: EST, name: "Lanchonete Demo", type: "restaurante", ownerUid: EST, status: "active", createdAt: 0,
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

// Ao contrário de systemContent (só a primeira mensagem "system", o prompt
// base), esta junta TODAS as mensagens "system" da última chamada — inclui
// as correções injetadas no meio do loop de ferramentas (ex.: a trava de
// claimsOrderConfirmed empurra uma nova mensagem "system" antes do retry).
function allSystemContent(): string {
  return (completionInput?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => String(m.content ?? ""))
    .join("\n---\n");
}

function makeTurn(phone: string) {
  return async function turn(text: string, history: Message[], task: ConversationTask | null) {
    const context = commercialContext();
    const demoAuthorization = authorization();
    const capabilities = capabilitiesForConversation({ context, bookingEnabled: false, ordersEnabled: true, demoAuthorized: true });
    const historyForAI: Message[] = [...history, { id: `c${history.length}`, role: "customer", text, at: NOW.getTime() }];
    const currentOrder = await getActiveOrder(EST, phone);
    const r = await think({
      est, kb, history: historyForAI, contactPhone: phone, contactName: "Prospect", customerProfile: null, task,
      intent: { type: "general_question", confidence: 0.5, entities: {} },
      prospectingContext: prospectingContext(), demoAuthorization, conversationContext: context, capabilities,
      orderAwaitingConfirmation: currentOrder?.status === "awaiting_confirmation" ? { orderId: currentOrder.id, version: currentOrder.version } : null,
    });
    history.push({ id: `c${history.length}`, role: "customer", text, at: NOW.getTime() });
    history.push({ id: `b${history.length}`, role: "bot", text: r.reply, at: NOW.getTime() });
    return { result: r, history, task: null as ConversationTask | null };
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  modelScript = [];
  completionInput = null;
  fakeDb.reset();
  fakeDb.col("establishments").set(EST, { id: EST, bot: { bookingEnabled: false, ordersEnabled: true } });
  await seedDemoCatalog(EST);
});
afterEach(() => vi.useRealTimers());

describe("F5.6 — claimsOrderConfirmed (detector)", () => {
  it("reconhece afirmações de pedido confirmado/registrado/fechado", () => {
    expect(claimsOrderConfirmed("O pedido ficou confirmado para entrega no endereço informado.")).toBe(true);
    expect(claimsOrderConfirmed("Prontinho! Pedido registrado com sucesso.")).toBe(true);
    expect(claimsOrderConfirmed("Confirmado! Seu pedido já está anotado.")).toBe(true);
    expect(claimsOrderConfirmed("Fechei seu pedido, obrigada!")).toBe(true);
  });

  it("NÃO confunde uma pergunta ou um pedido em andamento com uma confirmação", () => {
    expect(claimsOrderConfirmed("Posso confirmar o pedido para entrega no endereço informado?")).toBe(false);
    expect(claimsOrderConfirmed("Vou anotar seu pedido, só um momento com os itens.")).toBe(false);
    expect(claimsOrderConfirmed("Qual é o bairro e o complemento?")).toBe(false);
    expect(claimsOrderConfirmed("Confira seu pedido: 1x X-Burger. Total: R$ 24,00. Se estiver tudo certo, responda \"confirmo\".")).toBe(false);
  });
});

describe("F5.6 — pagamento e resumo canônico são obrigatórios antes de declarar o pedido fechado", () => {
  it("reproduz o transcript real corrigido: entrega → endereço → PAGAMENTO (obrigatório) → resumo canônico → confirmação explícita → confirm_order real", async () => {
    const phone = "5511900000201";
    const turn = makeTurn(phone);
    modelScript = [
      toolBatch({ name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true } }),
      say("Perfeito! X-Burger. Quer adicionar algo?"),
    ];
    const t1 = await turn("quero um x-burger", [], null);

    modelScript = [
      toolBatch({ name: "add_order_item", args: { productId: "demo-prod-coca", variantId: "demo-var-coca-lata", quantity: 1, __allowDraftCreation: true } }),
      say("Beleza, adicionei a Coca também. Quer mais alguma coisa?"),
    ];
    const t1b = await turn("e uma coca lata", t1.history, t1.task);

    modelScript = [say("Combinado, sem adicionais. Vai ser para retirada ou entrega?")];
    const t2 = await turn("nao", t1b.history, t1b.task);

    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "delivery" }), say("Me informe o endereço completo.")];
    const t3 = await turn("entrega", t2.history, t2.task);
    expect((await getActiveOrder(EST, phone))?.fulfillment).toBe("delivery");

    modelScript = [toolCall("set_order_address", { raw: "Rua João Saad, 321", neighborhood: "Planalto" }), say("Qual a forma de pagamento: pix, dinheiro ou cartão?")];
    const t4 = await turn("rua joao saad 321, bairro planalto", t3.history, t3.task);
    const afterAddress = await getActiveOrder(EST, phone);
    expect(afterAddress?.deliveryAddress).toMatchObject({ raw: "Rua João Saad, 321", neighborhood: "Planalto" });
    // Etapa de pagamento é pedida ANTES de qualquer resumo/confirmação —
    // nenhuma tool de pedido foi chamada além do endereço.
    expect(t4.result.toolCalls.map((c) => c.name)).not.toContain("prepare_order_confirmation");
    expect(t4.result.toolCalls.map((c) => c.name)).not.toContain("confirm_order");

    modelScript = [toolCall("set_order_payment", { method: "pix" }), toolCall("prepare_order_confirmation", {})];
    const t5 = await turn("pix", t4.history, t4.task);
    // prepare_order_confirmation curto-circuita think() com o resumo canônico
    // do backend — nunca com texto composto pelo modelo.
    expect(t5.result.reply).toContain("Confira seu pedido");
    expect(t5.result.reply).toContain("Total:");
    expect(t5.result.reply).toMatch(/responda.*confirmo/i);
    const awaiting = await getActiveOrder(EST, phone);
    expect(awaiting?.status).toBe("awaiting_confirmation");
    expect(awaiting?.payment).toMatchObject({ method: "pix" });

    modelScript = [toolCall("confirm_order", { orderId: awaiting!.id, version: awaiting!.version })];
    const t6 = await turn("sim", t5.history, t5.task);
    expect(t6.result.toolCalls.map((c) => c.name)).toContain("confirm_order");
    expect(t6.result.reply).toContain("Pedido registrado no sistema");
    expect(t6.result.reply).toContain("demonstrativo");

    const confirmed = await getOrder(EST, awaiting!.id);
    expect(confirmed).toMatchObject({ status: "confirmed", mode: "demo", prospectingLeadId: LEAD });
    expect(await getActiveOrder(EST, phone)).toBeNull();
    // Isolamento F2: o pedido demo confirmado nunca aparece na operação real.
    expect(await listOrders(EST)).toEqual([]);
  });

  it("teste negativo: sem pagamento, o modelo NÃO pode declarar o pedido confirmado — a trava intercepta a mentira e o pedido continua em draft", async () => {
    const phone = "5511900000202";
    const turn = makeTurn(phone);
    modelScript = [
      toolBatch({ name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true } }),
      say("Perfeito! X-Burger, R$ 24,00. Retirada ou entrega?"),
    ];
    const t1 = await turn("quero um x-burger", [], null);

    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "pickup" }), say("Combinado, retirada no local.")];
    const t2 = await turn("retirada", t1.history, t1.task);
    expect((await getActiveOrder(EST, phone))?.fulfillment).toBe("pickup");

    // O modelo PULA a pergunta de pagamento e, sem chamar nenhuma tool,
    // declara o pedido confirmado em texto livre — exatamente o bug relatado.
    modelScript = [
      say("O pedido ficou confirmado para retirada no local."),
      say("Ainda falta a forma de pagamento. Como você prefere pagar: pix, dinheiro ou cartão?"),
    ];
    const t3 = await turn("sim, pode confirmar", t2.history, t2.task);

    // A trava (claimsOrderConfirmed && !orderConfirmedThisTurn) corrigiu a
    // resposta antes de ela chegar ao cliente: nenhuma tool de fechamento
    // rodou e a réplica final não afirma um pedido confirmado.
    expect(t3.result.toolCalls.map((c) => c.name)).not.toContain("confirm_order");
    expect(t3.result.toolCalls.map((c) => c.name)).not.toContain("prepare_order_confirmation");
    expect(claimsOrderConfirmed(t3.result.reply)).toBe(false);
    expect(allSystemContent()).toContain("confirm_order NÃO foi executado com sucesso");

    const order = await getActiveOrder(EST, phone);
    expect(order?.status).toBe("draft");
    expect(order?.payment.method).toBeNull();
    // Nenhum pedido chegou a existir na operação real.
    expect(await listOrders(EST)).toEqual([]);
  });

  it("teste negativo: pagamento definido mas SEM prepare_order_confirmation — o modelo ainda assim não pode declarar/registrar o pedido fechado", async () => {
    const phone = "5511900000203";
    const turn = makeTurn(phone);
    modelScript = [
      toolBatch({ name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true } }),
      say("Perfeito! X-Burger, R$ 24,00. Retirada ou entrega?"),
    ];
    const t1 = await turn("quero um x-burger", [], null);

    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "pickup" }), say("Combinado. Como vai pagar?")];
    const t2 = await turn("retirada", t1.history, t1.task);

    modelScript = [toolCall("set_order_payment", { method: "cash" }), say("Pagamento em dinheiro, combinado.")];
    const t3 = await turn("dinheiro", t2.history, t2.task);
    expect((await getActiveOrder(EST, phone))?.payment).toMatchObject({ method: "cash" });

    // Pagamento já está definido, mas prepare_order_confirmation NUNCA foi
    // chamado — não existe resumo canônico pendente, então confirm_order não
    // pode ter rodado. Mesmo assim o modelo declara "pedido registrado".
    modelScript = [
      say("Seu pedido já está registrado no sistema."),
      say("Posso confirmar? Aqui está o resumo: 1x X-Burger, R$ 24,00, retirada, pagamento em dinheiro. Responda \"confirmo\" para fechar."),
    ];
    const t4 = await turn("show", t3.history, t3.task);

    expect(t4.result.toolCalls.map((c) => c.name)).not.toContain("confirm_order");
    expect(claimsOrderConfirmed(t4.result.reply)).toBe(false);

    const order = await getActiveOrder(EST, phone);
    expect(order?.status).toBe("draft");
    expect(await listOrders(EST)).toEqual([]);
  });

  it("teste: 'sim' logo após montar o carrinho, antes de qualquer resumo, não confirma o pedido prematuramente", async () => {
    const phone = "5511900000204";
    const turn = makeTurn(phone);
    modelScript = [
      toolBatch({ name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true } }),
      say("Perfeito! X-Burger, R$ 24,00. Quer mais alguma coisa?"),
    ];
    const t1 = await turn("quero um x-burger", [], null);

    // Sem entrega/retirada, sem endereço, sem pagamento e sem resumo — o
    // cliente já manda "sim" e o modelo tenta fechar direto.
    modelScript = [
      say("Show, pedido confirmado!"),
      say("Ainda preciso saber: vai ser para retirada ou entrega?"),
    ];
    const t2 = await turn("sim", t1.history, t1.task);

    expect(t2.result.toolCalls.map((c) => c.name)).not.toContain("confirm_order");
    expect(claimsOrderConfirmed(t2.result.reply)).toBe(false);
    const order = await getActiveOrder(EST, phone);
    expect(order?.status).toBe("draft");
    expect(order?.fulfillment).toBeFalsy();
  });

  it("retirada: sem endereço de entrega, mas pagamento e resumo canônico continuam obrigatórios antes da confirmação demo", async () => {
    const phone = "5511900000205";
    const turn = makeTurn(phone);
    modelScript = [
      toolBatch({ name: "add_order_item", args: { productId: "demo-prod-xsalada", quantity: 1, __allowDraftCreation: true } }),
      say("Perfeito! X-Salada, R$ 26,00. Retirada ou entrega?"),
    ];
    const t1 = await turn("quero um x-salada", [], null);

    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "pickup" }), say("Combinado, retirada no local. Como vai pagar?")];
    const t2 = await turn("retirada", t1.history, t1.task);
    const afterPickup = await getActiveOrder(EST, phone);
    expect(afterPickup?.fulfillment).toBe("pickup");
    expect(afterPickup?.deliveryAddress).toBeNull();

    modelScript = [toolCall("set_order_payment", { method: "credit_card" }), toolCall("prepare_order_confirmation", {})];
    const t3 = await turn("cartao", t2.history, t2.task);
    expect(t3.result.reply).toContain("Confira seu pedido");
    expect(t3.result.reply).toContain("Retirada no local");
    const awaiting = await getActiveOrder(EST, phone);
    expect(awaiting?.status).toBe("awaiting_confirmation");

    modelScript = [toolCall("confirm_order", { orderId: awaiting!.id, version: awaiting!.version })];
    const t4 = await turn("confirmo", t3.history, t3.task);
    expect(t4.result.reply).toContain("Pedido registrado no sistema");

    const confirmed = await getOrder(EST, awaiting!.id);
    expect(confirmed).toMatchObject({ status: "confirmed", mode: "demo", fulfillment: "pickup", prospectingLeadId: LEAD });
    expect(await listOrders(EST)).toEqual([]);
  });
});
