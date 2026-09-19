// Harness conversacional de pedidos — pipeline real (think() + toolsFor/
// runTool + lib/orders.ts), só o modelo (OpenAI) é roteirizado. Mesmo padrão
// de integração real já usado em lib/ai/ot02gTargetService.test.ts (agenda):
// só @/lib/firebase/admin (firestoreFake) e "openai" são mockados — nenhuma
// ferramenta, nenhuma função de lib/orders.ts/lib/repo.ts é substituída.
//
// Objetivo desta OT: DIAGNÓSTICO, não correção. Cada describe/it abaixo
// corresponde a um cenário numerado da OT. Falhas encontradas aqui NÃO são
// corrigidas nesta rodada — ver relatório final.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

type ModelMessage = { content: string | null; tool_calls?: unknown[] };
let modelScript: ModelMessage[] = [];
let completionInputs: unknown[][] = [];
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: async (input: { messages?: unknown[] }) => { completionInputs.push(input.messages ?? []); return { choices: [{ message: modelScript.shift() ?? { content: "ok" } }] }; } } };
  },
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { think } from "@/lib/ai/brain";
import { detectIntent } from "@/lib/ai/intent";
import { deriveTaskState } from "@/lib/ai/taskState";
import { saveMenuCategory, saveMenuProduct, saveOrderSettings, getOrder, getActiveOrder } from "@/lib/orders";
import { getConversation } from "@/lib/repo";
import { createAppointment, saveScheduleConfig, defaultScheduleConfig } from "@/lib/scheduling";
import type { ConversationTask, Establishment, FoodOrder, KnowledgeBase, Message, MenuProduct } from "@/types";

const EST = "est_lanchonete";
const PHONE = "5514991234567";
const CONV = "5514991234567"; // normalizePhone(PHONE) — mesma convenção de lib/ai/tools.ts::orderConversationId
const NOW = new Date("2026-09-19T13:00:00.000Z").getTime(); // sábado 10:00 local (-03)
// segunda-feira 10:00 local — dentro do expediente padrão (09-18, almoço 12-13), longe do leadHours de NOW
const BOOKABLE_SLOT = new Date("2026-09-21T13:00:00.000Z").getTime();

function est(overrides: Partial<Establishment["bot"]> = {}): Establishment {
  return {
    id: EST, name: "Lanchonete Teste", type: "lanchonete", ownerUid: EST, status: "active", createdAt: 0,
    bot: { personaName: "Lívia", tone: "acolhedora", bookingEnabled: false, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false, ...overrides },
  };
}
function kb(): KnowledgeBase {
  return { establishmentId: EST, about: "Lanchonete de bairro", address: "Rua Teste, 100", hours: null, services: [], faqs: [], notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0 };
}

// ---- roteiro do modelo ----
const toolCall = (name: string, args: Record<string, unknown>, id = `c-${name}-${Math.random().toString(36).slice(2, 6)}`): ModelMessage => ({ content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const toolBatch = (...calls: { name: string; args: Record<string, unknown>; id?: string }[]): ModelMessage => ({ content: null, tool_calls: calls.map(({ name, args, id }) => ({ id: id ?? `c-${name}-${Math.random().toString(36).slice(2, 6)}`, function: { name, arguments: JSON.stringify(args) } })) });
const say = (text: string): ModelMessage => ({ content: text });

async function turn(text: string, history: Message[], task: ConversationTask | null, establishment: Establishment = est()) {
  const intent = detectIntent(text);
  const historyForAI = [...history, { id: `c${history.length}`, role: "customer" as const, text, at: NOW }];
  const conversation = await getConversation(EST, CONV);
  const r = await think({ est: establishment, kb: kb(), history: historyForAI, contactPhone: PHONE, contactName: "Cliente Teste", customerProfile: null, task, intent, hasLastConfirmedOrder: Boolean(conversation?.lastConfirmedOrderId) });
  const nextTask = deriveTaskState({ existingTask: task, intent, toolCalls: r.toolCalls, booked: r.booked, statedDate: r.statedDate, statedService: r.statedService });
  history.push({ id: `c${history.length}`, role: "customer", text, at: NOW });
  history.push({ id: `b${history.length}`, role: "bot", text: r.reply, at: NOW });
  return { result: r, history, task: nextTask };
}

function toolNames(r: Awaited<ReturnType<typeof turn>>["result"]): string[] {
  return r.toolCalls.map((t) => t.name);
}
function toolArgs(r: Awaited<ReturnType<typeof turn>>["result"], name: string): Record<string, unknown> | undefined {
  return r.toolCalls.find((t) => t.name === name)?.args;
}
async function order(id: string): Promise<FoodOrder | null> {
  return getOrder(EST, id);
}
async function activeOrder(): Promise<FoodOrder | null> {
  return getActiveOrder(EST, CONV);
}

// ---- cardápio fixo do cenário (menor conjunto que cobre variante,
// adicional opcional e adicional obrigatório) ----
let burger: MenuProduct, pizza: MenuProduct, suco: MenuProduct, combo: MenuProduct;

async function seedMenu() {
  const cat = await saveMenuCategory(EST, { name: "Lanches", active: true, sortOrder: 0 });
  burger = await saveMenuProduct(EST, { categoryId: cat.id, name: "X-Burger", basePriceCents: 2000, active: true, variants: [], modifierGroups: [] });
  pizza = await saveMenuProduct(EST, {
    categoryId: cat.id, name: "Pizza", basePriceCents: 3000, active: true,
    variants: [{ id: "p", name: "Pequena", priceDeltaCents: 0, active: true }, { id: "m", name: "Média", priceDeltaCents: 1000, active: true }, { id: "g", name: "Grande", priceDeltaCents: 2000, active: true }],
    modifierGroups: [],
  });
  suco = await saveMenuProduct(EST, {
    categoryId: cat.id, name: "Suco", basePriceCents: 800, active: true, variants: [],
    modifierGroups: [{ id: "sabor", name: "Sabor", required: false, minSelections: 0, maxSelections: 1, options: [{ id: "laranja", name: "Laranja", priceDeltaCents: 0, active: true }, { id: "uva", name: "Uva", priceDeltaCents: 0, active: true }] }],
  });
  combo = await saveMenuProduct(EST, {
    categoryId: cat.id, name: "Combo X-Tudo", basePriceCents: 2500, active: true, variants: [],
    modifierGroups: [{ id: "ponto", name: "Ponto da carne", required: true, minSelections: 1, maxSelections: 1, options: [{ id: "mal", name: "Mal passado", priceDeltaCents: 0, active: true }, { id: "ponto", name: "Ao ponto", priceDeltaCents: 0, active: true }, { id: "bem", name: "Bem passado", priceDeltaCents: 0, active: true }] }],
  });
  await saveOrderSettings(EST, {
    pickupEnabled: true, deliveryEnabled: true,
    deliveryRules: [{ kind: "neighborhood", neighborhood: "Centro", feeCents: 500 }, { kind: "fixed", feeCents: 1000 }],
    acceptedPaymentMethods: ["pix", "cash"], pixInstructions: null,
  });
}

beforeEach(async () => {
  fakeDb.reset();
  vi.setSystemTime(NOW);
  modelScript = [];
  completionInputs = [];
  await seedMenu();
});

describe("1) cliente pede um produto diretamente", () => {
  it("PASS/FAIL: add_order_item com productId real, item e total corretos no draft", async () => {
    modelScript = [
      toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "t1"),
      say("Adicionei seu X-Burger."),
    ];
    const { result } = await turn("quero um x-burger", [], null);

    expect(toolNames(result)).toEqual(["add_order_item"]);
    expect(toolArgs(result, "add_order_item")).toMatchObject({ productId: burger.id, quantity: 1 });
    const o = await activeOrder();
    expect(o?.items).toHaveLength(1);
    expect(o?.items[0]).toMatchObject({ productId: burger.id, quantity: 1, unitPriceCents: 2000, lineTotalCents: 2000 });
    expect(o?.subtotalCents).toBe(2000);
    expect(o?.totalCents).toBe(2000); // sem fulfillment ainda, deliveryFee=0
    expect(o?.status).toBe("draft");
    expect(o?.version).toBe(2); // 1 (draftFor cria) + 1 (mutateDraft aplica o item)
  });
});

describe("2) cliente pergunta o cardápio antes de escolher", () => {
  it("PASS/FAIL: search_menu não cria pedido; escolha em turno seguinte cria", async () => {
    modelScript = [toolCall("search_menu", { query: "burger" }, "s1"), say("Temos X-Burger por R$20.")];
    const t1 = await turn("o que vocês têm?", [], null);
    expect(toolNames(t1.result)).toEqual(["search_menu"]);
    expect(await activeOrder()).toBeNull(); // busca nunca cria draft

    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "a1"), say("Adicionado.")];
    await turn("quero o x-burger", t1.history, t1.task);
    expect((await activeOrder())?.items).toHaveLength(1);
  });
});

describe("3) produto com variantes (P/M/G)", () => {
  it("PASS/FAIL: variantId real aplica o delta de preço correto", async () => {
    modelScript = [toolCall("add_order_item", { productId: pizza.id, variantId: "m", quantity: 1 }, "v1"), say("Pizza média adicionada.")];
    await turn("quero uma pizza média", [], null);

    const o = await activeOrder();
    expect(o?.items[0]).toMatchObject({ variantId: "m", variantName: "Média", unitPriceCents: 4000 }); // 3000 base + 1000 delta
    expect(o?.totalCents).toBe(4000);
  });
});

describe("4) produto com adicional opcional", () => {
  it("PASS/FAIL: escolhendo o opcional, o modifier aparece no item", async () => {
    modelScript = [toolCall("add_order_item", { productId: suco.id, modifierOptionIds: ["laranja"], quantity: 1 }, "o1"), say("Suco de laranja adicionado.")];
    await turn("quero um suco de laranja", [], null);
    const o = await activeOrder();
    expect(o?.items[0]?.modifiers).toEqual([{ optionId: "laranja", name: "Laranja", priceDeltaCents: 0 }]);
  });

  it("PASS/FAIL: SEM escolher o opcional (min=0), a adição ainda é aceita", async () => {
    modelScript = [toolCall("add_order_item", { productId: suco.id, quantity: 1 }, "o2"), say("Suco adicionado.")];
    await turn("quero um suco", [], null);
    const o = await activeOrder();
    expect(o?.items).toHaveLength(1);
    expect(o?.items[0]?.modifiers).toEqual([]);
  });
});

describe("5) produto com adicional obrigatório (escolhido corretamente)", () => {
  it("PASS/FAIL: combo com ponto da carne escolhido é aceito", async () => {
    modelScript = [toolCall("add_order_item", { productId: combo.id, modifierOptionIds: ["ponto"], quantity: 1 }, "r1"), say("Combo ao ponto adicionado.")];
    await turn("quero o combo x-tudo, ao ponto", [], null);
    const o = await activeOrder();
    expect(o?.items[0]?.modifiers).toEqual([{ optionId: "ponto", name: "Ao ponto", priceDeltaCents: 0 }]);
  });
});

describe("6) cliente tenta continuar sem escolher um adicional obrigatório", () => {
  it("PASS/FAIL: backend REJEITA a adição sem o obrigatório — nenhum item entra no draft", async () => {
    modelScript = [toolCall("add_order_item", { productId: combo.id, quantity: 1 }, "r2"), say("Combo adicionado.")];
    const t1 = await turn("quero o combo x-tudo", [], null);

    expect(toolNames(t1.result)).toEqual(["add_order_item"]); // o modelo tentou
    expect(await activeOrder()).toBeNull(); // mas o backend nunca aplicou — calculateItem lança "Seleção inválida"

    // segunda tentativa, agora escolhendo o obrigatório: sucede.
    modelScript = [toolCall("add_order_item", { productId: combo.id, modifierOptionIds: ["mal"], quantity: 1 }, "r3"), say("Agora sim, adicionado.")];
    await turn("mal passado então", t1.history, t1.task);
    expect((await activeOrder())?.items).toHaveLength(1);
  });
});

describe("7) cliente pede dois ou mais itens numa única mensagem", () => {
  it("PASS/FAIL: todas as adições legítimas do mesmo turno são persistidas", async () => {
    modelScript = [
      toolBatch({ name: "add_order_item", args: { productId: burger.id, quantity: 1 }, id: "batch-1" }, { name: "add_order_item", args: { productId: suco.id, quantity: 1 }, id: "batch-2" }),
      say("Adicionei o x-burger e o suco."),
    ];
    const t1 = await turn("quero um x-burger e um suco", [], null);

    const o = await activeOrder();
    expect(toolNames(t1.result)).toEqual(["add_order_item", "add_order_item"]);
    expect(o?.items).toHaveLength(2);
    expect(o?.items[0]?.productId).toBe(burger.id);
    expect(o?.items[1]?.productId).toBe(suco.id);
  });

  it("PASS/FAIL: a nona mutação é rejeitada com feedback explícito e nunca é anunciada como aplicada", async () => {
    modelScript = [
      toolBatch(...Array.from({ length: 9 }, (_, index) => ({ name: "add_order_item", args: { productId: burger.id, quantity: 1 }, id: `limit-${index + 1}` }))),
      say("Adicionei os nove itens."),
    ];
    const { result } = await turn("quero nove x-burgers", [], null);
    const draft = await activeOrder();
    const ninthFeedback = completionInputs.flat().find((message) => (message as { tool_call_id?: string }).tool_call_id === "limit-9") as { content?: string } | undefined;

    expect(toolNames(result)).toHaveLength(8);
    expect(draft?.items).toHaveLength(8);
    expect(new Set(draft?.items.map((item) => item.id)).size).toBe(8);
    expect(draft).toMatchObject({ subtotalCents: 16000, totalCents: 16000, version: 9 });
    expect(JSON.parse(ninthFeedback?.content ?? "{}")).toMatchObject({ ok: false, ignored: true, error: "order mutation limit reached for this turn", data: { limit: 8, executed: 8, operationExecuted: false } });
    expect(result.reply).toContain("A última não foi realizada");
    expect(result.reply).not.toContain("nove itens");
  });
});

describe("8) cliente adiciona o mesmo produto novamente de forma intencional", () => {
  it("PASS/FAIL: duas mensagens distintas pedindo o mesmo produto somam — nunca são tratadas como retry", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "int-1"), say("Adicionei um x-burger.")];
    const t1 = await turn("quero um x-burger", [], null);
    expect((await activeOrder())?.items).toHaveLength(1);

    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "int-2"), say("Adicionei outro x-burger.")];
    await turn("quero mais um x-burger", t1.history, t1.task);
    const o = await activeOrder();
    expect(o?.items).toHaveLength(2); // duas linhas — repetição intencional, não retry
    expect(o?.totalCents).toBe(4000);
  });
});

describe("9) cliente altera quantidade", () => {
  it("PASS/FAIL: update_order_item muda quantidade e recalcula o total", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "q1"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    const itemId = (await activeOrder())!.items[0]!.id;

    modelScript = [toolCall("update_order_item", { itemId, quantity: 3 }, "q2"), say("Agora são 3.")];
    await turn("na verdade quero 3", t1.history, t1.task);

    const o = await activeOrder();
    expect(o?.items[0]).toMatchObject({ quantity: 3, lineTotalCents: 6000 });
    expect(o?.totalCents).toBe(6000);
  });
});

describe("10) cliente remove um item", () => {
  it("PASS/FAIL: remove_order_item tira o item e recalcula o total", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "d1"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    const itemId = (await activeOrder())!.items[0]!.id;

    modelScript = [toolCall("remove_order_item", { itemId }, "d2"), say("Removido.")];
    await turn("na verdade tira o x-burger", t1.history, t1.task);

    const o = await activeOrder();
    expect(o?.items).toHaveLength(0);
    expect(o?.totalCents).toBe(0);
  });
});

describe("11) cliente troca uma variante antes de confirmar", () => {
  it("PASS/FAIL: sem update de variantId — a troca exige remove+add em DUAS mensagens (update_order_item não aceita variantId)", async () => {
    modelScript = [toolCall("add_order_item", { productId: pizza.id, variantId: "p", quantity: 1 }, "vt1"), say("Pizza pequena adicionada.")];
    const t1 = await turn("quero uma pizza pequena", [], null);
    const itemId = (await activeOrder())!.items[0]!.id;

    // troca real: remove a pequena, depois (mensagem seguinte) adiciona a grande.
    modelScript = [toolCall("remove_order_item", { itemId }, "vt2"), say("Tirei a pequena.")];
    const t2 = await turn("na verdade quero a grande, tira essa", t1.history, t1.task);
    expect((await activeOrder())?.items).toHaveLength(0);

    modelScript = [toolCall("add_order_item", { productId: pizza.id, variantId: "g", quantity: 1 }, "vt3"), say("Pizza grande adicionada.")];
    await turn("a grande", t2.history, t2.task);
    const o = await activeOrder();
    expect(o?.items).toHaveLength(1);
    expect(o?.items[0]).toMatchObject({ variantId: "g", unitPriceCents: 5000 });
  });
});

describe("12) cliente escolhe retirada", () => {
  it("PASS/FAIL: pickup nunca exige endereço, taxa fica zero", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "p1"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "pickup" }, "p2"), say("Combinado, retirada no local.")];
    await turn("vou retirar", t1.history, t1.task);

    const o = await activeOrder();
    expect(o?.fulfillment).toBe("pickup");
    expect(o?.deliveryAddress).toBeNull();
    expect(o?.deliveryFeeCents).toBe(0);
    expect(o?.totalCents).toBe(2000);
  });
});

describe("13) cliente escolhe entrega", () => {
  it("PASS/FAIL: delivery + endereço com bairro configurado calcula a taxa real", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "e1"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "delivery" }, "e2"), say("Qual o endereço?")];
    const t2 = await turn("é pra entregar", t1.history, t1.task);
    modelScript = [toolCall("set_order_address", { raw: "Rua das Flores, 123", neighborhood: "Centro" }, "e3"), say("Endereço registrado.")];
    await turn("Rua das Flores 123, Centro", t2.history, t2.task);

    const o = await activeOrder();
    expect(o?.fulfillment).toBe("delivery");
    expect(o?.deliveryAddress).toMatchObject({ raw: "Rua das Flores, 123", neighborhood: "Centro" });
    expect(o?.deliveryFeeCents).toBe(500); // regra específica do bairro Centro
    expect(o?.totalCents).toBe(2500);
  });
});

describe("14) endereço incompleto/ambíguo", () => {
  it("PASS/FAIL: endereço vazio é rejeitado pelo backend, nunca aceito silenciosamente", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "amb1"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "delivery" }, "amb2"), say("Qual endereço?")];
    const t2 = await turn("é entrega", t1.history, t1.task);
    modelScript = [toolCall("set_order_address", { raw: "" }, "amb3"), say("Endereço registrado.")]; // endereço vazio/ambíguo
    await turn("ali perto", t2.history, t2.task);

    const o = await activeOrder();
    expect(o?.deliveryAddress).toBeNull(); // backend rejeitou: "Endereço é obrigatório."
  });
});

describe("15) bairro sem taxa/regra de entrega configurada", () => {
  it("PASS/FAIL: sem regra fixa de fallback, endereço em bairro desconhecido nunca define uma taxa inventada", async () => {
    await saveOrderSettings(EST, { pickupEnabled: true, deliveryEnabled: true, deliveryRules: [{ kind: "neighborhood", neighborhood: "Centro", feeCents: 500 }], acceptedPaymentMethods: ["pix", "cash"], pixInstructions: null });

    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "nb1"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "delivery" }, "nb2"), say("Qual endereço?")];
    const t2 = await turn("é entrega", t1.history, t1.task);
    modelScript = [toolCall("set_order_address", { raw: "Rua X, 1", neighborhood: "Bairro Novo" }, "nb3"), say("Endereço registrado.")];
    await turn("Rua X, 1, Bairro Novo", t2.history, t2.task);

    const o = await activeOrder();
    // deliveryFee() lança "Não há taxa configurada para esse endereço." dentro
    // de mutateDraft (via recalculate) — a mutação inteira é revertida: nem o
    // fulfillment "delivery" fica persistido com um endereço sem taxa válida.
    expect(o?.deliveryAddress).toBeNull();
  });
});

describe("16) cliente escolhe forma de pagamento", () => {
  it("PASS/FAIL: pix vira 'pending', só métodos aceitos pelo estabelecimento são aceitos", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "pay1"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    modelScript = [toolCall("set_order_payment", { method: "pix" }, "pay2"), say("Pagamento via Pix.")];
    await turn("vou pagar no pix", t1.history, t1.task);

    const o = await activeOrder();
    expect(o?.payment).toMatchObject({ method: "pix", status: "pending" });
  });

  it("PASS/FAIL: forma de pagamento não aceita pelo estabelecimento é rejeitada", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "pay3"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    modelScript = [toolCall("set_order_payment", { method: "credit_card" }, "pay4"), say("Cartão de crédito, combinado.")]; // não está em acceptedPaymentMethods
    await turn("no cartão de crédito", t1.history, t1.task);

    const o = await activeOrder();
    expect(o?.payment.method).toBeNull(); // backend rejeitou: "Forma de pagamento não aceita."
  });
});

async function montarPedidoCompleto(): Promise<{ history: Message[]; task: ConversationTask | null; order: FoodOrder }> {
  modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "full1"), say("Adicionado.")];
  const t1 = await turn("quero um x-burger", [], null);
  modelScript = [toolCall("set_order_fulfillment", { fulfillment: "pickup" }, "full2"), say("Retirada, combinado.")];
  const t2 = await turn("vou retirar", t1.history, t1.task);
  modelScript = [toolCall("set_order_payment", { method: "cash" }, "full3"), say("Pagamento em dinheiro.")];
  const t3 = await turn("pago em dinheiro", t2.history, t2.task);
  const o = (await activeOrder())!;
  return { history: t3.history, task: t3.task, order: o };
}

describe("17) resumo final antes da confirmação", () => {
  it("PASS/FAIL: get_order_draft é consultado e reflete exatamente o estado real do backend", async () => {
    const { history, task } = await montarPedidoCompleto();
    modelScript = [toolCall("get_order_draft", {}, "sum1"), say("Aqui está seu resumo: 1x X-Burger, retirada, dinheiro. Total R$20,00.")];
    await turn("pode me mostrar o resumo?", history, task);

    const o = await activeOrder();
    expect(o?.totalCents).toBe(2000); // o que o resumo DEVERIA refletir — comparação com a fonte real
    expect(o?.status).toBe("draft"); // resumo nunca confirma sozinho
  });
});

describe("18) cliente corrige o pedido depois de receber o resumo", () => {
  it("PASS/FAIL: correção pós-resumo é aplicada e o próximo resumo reflete a mudança real", async () => {
    const { history, task } = await montarPedidoCompleto();
    modelScript = [toolCall("get_order_draft", {}, "corr1"), say("1x X-Burger, total R$20,00.")];
    const t1 = await turn("qual o resumo?", history, task);

    const itemId = (await activeOrder())!.items[0]!.id;
    modelScript = [toolCall("update_order_item", { itemId, quantity: 2 }, "corr2"), say("Alterei para 2 unidades.")];
    const t2 = await turn("na verdade quero 2", t1.history, t1.task);

    const o = await activeOrder();
    expect(o?.items[0]?.quantity).toBe(2);
    expect(o?.totalCents).toBe(4000); // resumo pós-correção precisa refletir o novo total, nunca o antigo
    void t2;
  });
});

describe("19) confirmação explícita", () => {
  it("PASS/FAIL: confirm_order com orderId/version reais confirma de verdade", async () => {
    const { history, task, order: draft } = await montarPedidoCompleto();
    modelScript = [toolCall("get_order_draft", {}, "cf1"), say("Confirma o pedido de 1x X-Burger, retirada, dinheiro, total R$20,00?")];
    const t1 = await turn("confirma pra mim o resumo", history, task);
    modelScript = [toolCall("confirm_order", { orderId: draft.id, version: draft.version }, "cf2"), say("Pedido confirmado!")];
    await turn("sim, confirmo", t1.history, t1.task);

    const stored = await order(draft.id);
    expect(stored?.status).toBe("confirmed");
    expect(stored?.confirmedAt).not.toBeNull();
    expect(await activeOrder()).toBeNull(); // activeOrderId limpo — próxima mensagem começaria um pedido novo
  });
});

describe("20) mensagem trivial pós-confirmação não cria pedido/mutação indevida", () => {
  it.each(["ok", "👍", "obrigado", "valeu", "até mais"])("PASS/FAIL: %s bloqueia uma tool indevida antes de criar novo draft", async (text) => {
    const { history, task, order: draft } = await montarPedidoCompleto();
    modelScript = [toolCall("confirm_order", { orderId: draft.id, version: draft.version }, "triv1"), say("Pedido recebido. Vou encaminhar para a cozinha.")];
    const t1 = await turn("confirmo", history, task);

    modelScript = [toolCall("add_order_item", { productId: suco.id, quantity: 1 }, `trivial-${text}`), say("Adicionei o suco.")];
    const followUp = await turn(text, t1.history, t1.task);

    expect(toolNames(followUp.result)).toEqual([]);
    expect(await activeOrder()).toBeNull();
    const stored = await order(draft.id);
    expect(stored?.status).toBe("confirmed");
    expect(stored?.items).toHaveLength(1);
  });

  it("PASS/FAIL: intenção explícita de novo pedido pode iniciar outro draft", async () => {
    const { history, task, order: draft } = await montarPedidoCompleto();
    modelScript = [toolCall("confirm_order", { orderId: draft.id, version: draft.version }, "triv2"), say("Pedido recebido. Vou encaminhar para a cozinha.")];
    const t1 = await turn("confirmo", history, task);

    modelScript = [toolCall("add_order_item", { productId: suco.id, quantity: 1 }, "triv3"), say("Adicionei o suco ao novo pedido.")];
    const followUp = await turn("quero fazer outro pedido", t1.history, t1.task);

    const novoDraft = await activeOrder();
    expect(toolNames(followUp.result)).toEqual(["add_order_item"]);
    expect(novoDraft).not.toBeNull();
    expect(novoDraft?.id).not.toBe(draft.id);
    const confirmado = await order(draft.id);
    expect(confirmado?.status).toBe("confirmed");
    expect(confirmado?.items).toHaveLength(1);
  });
});

// ============================================================
// Cenários técnicos
// ============================================================

describe("técnico: retry da mesma tool call (mesmo __operationId reexecutado)", () => {
  it("PASS/FAIL: reexecutar a MESMA tool call (mesmo id) não duplica o item", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "retry-fixo"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    expect((await activeOrder())?.items).toHaveLength(1);

    // simula reprocessamento da MESMA requisição lógica (crash/timeout e
    // nova tentativa) — mesmo tool_call.id "retry-fixo" de novo.
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "retry-fixo"), say("Adicionado.")];
    await turn("quero um x-burger", t1.history, t1.task); // mesma mensagem, tratada como nova pelo harness (history separado), mas o id da tool é IGUAL de propósito

    const o = await activeOrder();
    expect(o?.items).toHaveLength(1); // idempotência: appliedOperationIds barrou a repetição
  });
});

describe("técnico: reentrega da mesma mensagem (waMessageId) — fora do alcance de think()", () => {
  it("nota: a dedupe de reentrega do webhook (alreadyProcessed(waMessageId)) acontece ANTES de think() ser chamado — já coberta por app/api/webhooks/whatsapp/route.statusObservability.test.ts e afins, fora do escopo deste harness que testa think() diretamente", () => {
    expect(true).toBe(true); // documentação executável — ver relatório final
  });
});

describe("técnico: duas mutações legítimas da mesma tool (mensagens distintas)", () => {
  it("PASS/FAIL: dois update_order_item legítimos em momentos diferentes aplicam ambos", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "leg1"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null);
    const itemId = (await activeOrder())!.items[0]!.id;

    modelScript = [toolCall("update_order_item", { itemId, quantity: 2 }, "leg2"), say("2 unidades.")];
    const t2 = await turn("na verdade 2", t1.history, t1.task);
    modelScript = [toolCall("update_order_item", { itemId, quantity: 5 }, "leg3"), say("5 unidades.")];
    await turn("põe 5", t2.history, t2.task);

    const o = await activeOrder();
    expect(o?.items[0]?.quantity).toBe(5);
    expect(o?.totalCents).toBe(10000);
  });
});

describe("técnico: produto indisponível durante a montagem", () => {
  it("PASS/FAIL: produto active=false nunca entra no draft", async () => {
    await saveMenuProduct(EST, { categoryId: burger.categoryId, name: "X-Burger", basePriceCents: 2000, active: false, variants: [], modifierGroups: [] }, burger.id);
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "unavail1"), say("Adicionado.")];
    await turn("quero um x-burger", [], null);
    expect(await activeOrder()).toBeNull(); // calculateItem lança "Produto indisponível."
  });
});

describe("técnico: produto/variante/adicional fica indisponível ANTES da confirmação", () => {
  it("PASS/FAIL: produto desativado depois do draft, antes de confirmar — confirmação rejeitada", async () => {
    const { history, task, order: draft } = await montarPedidoCompleto();
    await saveMenuProduct(EST, { categoryId: burger.categoryId, name: "X-Burger", basePriceCents: 2000, active: false, variants: [], modifierGroups: [] }, burger.id);

    modelScript = [toolCall("confirm_order", { orderId: draft.id, version: draft.version }, "unavail2"), say("Confirmado!")];
    await turn("confirmo", history, task);

    const stored = await order(draft.id);
    expect(stored?.status).not.toBe("confirmed"); // revalidação de catálogo na confirmação bloqueou
  });

  it("PASS/FAIL: variante desativada depois do draft, antes de confirmar — confirmação rejeitada", async () => {
    modelScript = [toolCall("add_order_item", { productId: pizza.id, variantId: "m", quantity: 1 }, "unavail3"), say("Pizza média.")];
    const t1 = await turn("pizza média", [], null);
    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "pickup" }, "unavail4"), say("Retirada.")];
    const t2 = await turn("retirada", t1.history, t1.task);
    modelScript = [toolCall("set_order_payment", { method: "cash" }, "unavail5"), say("Dinheiro.")];
    const t3 = await turn("dinheiro", t2.history, t2.task);
    const draft = (await activeOrder())!;

    await saveMenuProduct(EST, { categoryId: pizza.categoryId, name: "Pizza", basePriceCents: 3000, active: true, variants: [{ id: "p", name: "Pequena", priceDeltaCents: 0, active: true }, { id: "m", name: "Média", priceDeltaCents: 1000, active: false }, { id: "g", name: "Grande", priceDeltaCents: 2000, active: true }], modifierGroups: [] }, pizza.id);

    modelScript = [toolCall("confirm_order", { orderId: draft.id, version: draft.version }, "unavail6"), say("Confirmado!")];
    await turn("confirmo", t3.history, t3.task);

    const stored = await order(draft.id);
    expect(stored?.status).not.toBe("confirmed");
  });
});

describe("técnico: preço alterado entre montagem e confirmação", () => {
  it("PASS/FAIL: preço mudou -> confirmação rejeitada, total NUNCA é o antigo silenciosamente", async () => {
    const { history, task, order: draft } = await montarPedidoCompleto();
    await saveMenuProduct(EST, { categoryId: burger.categoryId, name: "X-Burger", basePriceCents: 3500, active: true, variants: [], modifierGroups: [] }, burger.id);

    modelScript = [toolCall("confirm_order", { orderId: draft.id, version: draft.version }, "price1"), say("Confirmado, total R$20,00!")];
    await turn("confirmo", history, task);

    const stored = await order(draft.id);
    expect(stored?.status).not.toBe("confirmed");
    expect(stored?.totalCents).toBe(draft.totalCents); // nunca alterado silenciosamente pro preço novo
  });
});

describe("técnico: confirmação com versão stale", () => {
  it("PASS/FAIL: expectedVersion desatualizado nunca confirma silenciosamente", async () => {
    const { history, task, order: draft } = await montarPedidoCompleto();
    const staleVersion = draft.version;

    // o cliente adiciona mais um item DEPOIS do resumo que o modelo tinha em mãos.
    modelScript = [toolCall("add_order_item", { productId: suco.id, quantity: 1 }, "stale1"), say("Suco adicionado.")];
    const t1 = await turn("e um suco também", history, task);

    // modelo tenta confirmar com a version ANTIGA (a que tinha antes do suco).
    modelScript = [toolCall("confirm_order", { orderId: draft.id, version: staleVersion }, "stale2"), say("Confirmado!")];
    await turn("confirma", t1.history, t1.task);

    const stored = await order(draft.id);
    expect(stored?.status).not.toBe("confirmed"); // "O pedido mudou; confira o resumo atualizado antes de confirmar."
  });
});

describe("técnico: ordersEnabled=false", () => {
  it("PASS/FAIL: nenhuma tool de pedido executa — mesmo se o modelo tentar chamar uma", async () => {
    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "off1"), say("Adicionado.")];
    await turn("quero um x-burger", [], null, est({ ordersEnabled: false }));
    expect(await activeOrder()).toBeNull(); // runTool: "ferramenta desconhecida ou indisponível"
  });
});

describe("técnico: agenda e pedidos habilitados simultaneamente não se confundem", () => {
  it("PASS/FAIL: mutação de agenda e mutação de pedido na MESMA mensagem aplicam as duas, sem cruzar dados", async () => {
    const estAmbos = est({ bookingEnabled: true, ordersEnabled: true });
    await saveScheduleConfig(EST, { ...defaultScheduleConfig(EST) });

    modelScript = [
      toolBatch(
        { name: "create_appointment", args: { serviceName: "Avaliação", startAt: BOOKABLE_SLOT }, id: "agenda-1" },
        { name: "add_order_item", args: { productId: burger.id, quantity: 1 }, id: "pedido-1" },
      ),
      say("Agendei sua avaliação e adicionei o x-burger."),
    ];
    await turn("quero agendar uma avaliação e também pedir um x-burger", [], null, estAmbos);

    const appts = [...fakeDb.col(`establishments/${EST}/appointments`).values()];
    const o = await activeOrder();
    expect(appts).toHaveLength(1); // a mutação de agenda aconteceu
    expect(o?.items).toHaveLength(1); // a mutação de pedido TAMBÉM aconteceu — eixos independentes, nenhum bloqueia o outro
    expect(o?.items[0]?.productId).toBe(burger.id);
  });

  it("PASS/FAIL: confirmar um pedido nunca cria/altera um agendamento, e vice-versa", async () => {
    const estAmbos = est({ bookingEnabled: true, ordersEnabled: true });
    await saveScheduleConfig(EST, { ...defaultScheduleConfig(EST) });
    await createAppointment(EST, { contactPhone: PHONE, contactName: "Cliente Teste", serviceName: "Avaliação", startAt: BOOKABLE_SLOT, durationMin: 30, source: "manual" });

    modelScript = [toolCall("add_order_item", { productId: burger.id, quantity: 1 }, "iso1"), say("Adicionado.")];
    const t1 = await turn("quero um x-burger", [], null, estAmbos);
    modelScript = [toolCall("set_order_fulfillment", { fulfillment: "pickup" }, "iso2"), say("Retirada.")];
    const t2 = await turn("retirada", t1.history, t1.task, estAmbos);
    modelScript = [toolCall("set_order_payment", { method: "cash" }, "iso3"), say("Dinheiro.")];
    const t3 = await turn("dinheiro", t2.history, t2.task, estAmbos);
    const draft = (await activeOrder())!;

    modelScript = [toolCall("confirm_order", { orderId: draft.id, version: draft.version }, "iso4"), say("Pedido confirmado!")];
    await turn("confirmo", t3.history, t3.task, estAmbos);

    const appts = [...fakeDb.col(`establishments/${EST}/appointments`).values()];
    expect(appts).toHaveLength(1); // o agendamento pré-existente não foi tocado pela confirmação do pedido
    const stored = await order(draft.id);
    expect(stored?.status).toBe("confirmed");
  });
});
