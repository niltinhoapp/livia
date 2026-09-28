// F5.4 — continuidade de tarefa entre agenda, pedido e FAQ.
//
// Caso real: depois de um agendamento de demonstração concluído, o cliente
// pediu "quero uma coca lata 350ml e x-burger", a Lívia listou duas opções de
// X-Burger e o cliente respondeu "1" — a resposta voltou para a agenda ("o
// horário das 10h está ocupado"). Estes testes provam, sem OpenAI real, que a
// escolha numérica é ancorada na última lista do bot, que ferramentas de
// agenda não rodam com ela e que listas de horários/serviços seguem no
// caminho determinístico da agenda, sem mudança.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ConversationTask, Establishment, Intent, KnowledgeBase, Message } from "@/types";

let capturedMessages: OpenAI.Chat.ChatCompletionMessageParam[] | null = null;
let scripted: Array<{ content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }> = [];

vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }) => {
    capturedMessages = [...input.messages];
    return scripted.shift() ?? { content: "Anotado!", tool_calls: undefined };
  }),
}));

const assertBookable = vi.fn(async () => null);
vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: vi.fn(async (id: string) => ({
    establishmentId: id,
    utcOffsetMinutes: -180,
    defaultDurationMin: 30,
    slotMinutes: 30,
    days: {},
  })),
  localToEpoch: vi.fn(() => 1_900_000_000_000),
  assertBookable: (...a: unknown[]) => assertBookable(...(a as [])),
  demoSlots: vi.fn(() => ({ kind: "demo", prospectingLeadId: null })),
  PRODUCTION_SLOTS: { kind: "production" },
}));

vi.mock("@/lib/repo", () => ({
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(async () => undefined),
}));

const runToolMock = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
  if (name === "get_customer_appointments") return { ok: false, error: "test-mock" };
  if (name === "create_appointment") return { ok: false, error: "ocupado", reasonCode: "slot_taken" };
  if (name === "find_available_appointments") return { ok: true, data: { date: "2026-10-02", slots: [] } };
  return { ok: true, data: {} };
});

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [],
  runTool: (...a: unknown[]) => runToolMock(...(a as [string, Record<string, unknown>])),
}));

const { think } = await import("./brain");
const { capabilitiesForConversation } = await import("./conversationPolicy");

const OTHER: Intent = { type: "general_question", confidence: 0.3, entities: {} };

function est(): Establishment {
  return {
    id: "lanchonete-test",
    name: "Lanchonete Teste",
    type: "restaurante",
    ownerUid: "owner-1",
    status: "active",
    createdAt: 0,
    bot: {
      personaName: "Lívia",
      tone: "acolhedora",
      bookingEnabled: true,
      ordersEnabled: true,
      medicalGuardrail: false,
      handoffKeywords: [],
      voiceRepliesEnabled: false,
    },
  } as unknown as Establishment;
}

let at = 1;
const customer = (text: string): Message => ({ id: `c${at}`, role: "customer", text, at: at++ });
const bot = (text: string): Message => ({ id: `b${at}`, role: "bot", text, at: at++ });

// Tarefa de agenda "presa": estado de escolha de horário, com data e serviço.
const STALE_AGENDA_TASK: ConversationTask = {
  type: "schedule_appointment",
  state: "confirm",
  collectedData: { date: "2026-10-02", serviceName: "Corte" },
  missingData: [],
  updatedAt: 0,
};

const XBURGER_LIST = "Temos duas opções de X-Burger:\n1. X-Burger — R$ 24,00\n2. X-Burger com bacon extra — R$ 29,00\nQual você prefere?";

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

function systemContent(): string {
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = capturedMessages ?? [];
  return String(msgs.find((m) => m.role === "system")?.content ?? "");
}

function runToolNames(): string[] {
  return runToolMock.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  capturedMessages = null;
  scripted = [];
  at = 1;
  vi.clearAllMocks();
});

describe("F5.4 — AGENDA → PEDIDO: '1' escolhe a opção da lista de produtos", () => {
  const history = [
    customer("quero marcar um corte"),
    bot("Prontinho! Seu horário de Corte está reservado para 02/10 às 10:00."),
    customer("quero uma coca lata 350ml e x-burger"),
    bot(XBURGER_LIST),
    customer("1"),
  ];

  it("não lê '1' como horário da tarefa de agenda anterior nem tenta reservar", async () => {
    await think({ est: est(), kb: null, history, contactPhone: "5511999990000", contactName: null, customerProfile: null, task: STALE_AGENDA_TASK, intent: OTHER });
    expect(runToolNames()).not.toContain("create_appointment");
    expect(assertBookable).not.toHaveBeenCalled();
  });

  it("ancora o turno na opção 1 (X-Burger) e não injeta a tarefa de agenda no prompt", async () => {
    await think({ est: est(), kb: null, history, contactPhone: "5511999990000", contactName: null, customerProfile: null, task: STALE_AGENDA_TASK, intent: OTHER });
    const prompt = systemContent();
    expect(prompt).toContain("ESCOLHA DE OPÇÃO DA SUA ÚLTIMA LISTA");
    expect(prompt).toContain("opção 1");
    expect(prompt).toContain("X-Burger — R$ 24,00");
    expect(prompt).not.toContain("Há uma tarefa em andamento");
  });

  it("bloqueia ferramentas de agenda do modelo e executa o item do pedido", async () => {
    scripted = [
      {
        content: null,
        tool_calls: [
          toolCall("t1", "create_appointment", { serviceName: "Corte", startAt: 1 }),
          toolCall("t2", "find_available_appointments", { date: "2026-10-02" }),
          toolCall("t3", "add_order_item", { productId: "demo-prod-xburger", quantity: 1 }),
        ],
      },
      { content: "Anotei 1 X-Burger no seu pedido!" },
    ];
    const result = await think({ est: est(), kb: null, history, contactPhone: "5511999990000", contactName: null, customerProfile: null, task: STALE_AGENDA_TASK, intent: OTHER });
    expect(runToolNames()).toEqual(["add_order_item"]);
    const addArgs = runToolMock.mock.calls.find((c) => c[0] === "add_order_item")?.[1] as Record<string, unknown>;
    // A lista foi a resposta a um pedido explícito ("quero ..."): a escolha
    // continua esse pedido e pode abrir o rascunho.
    expect(addArgs.__allowDraftCreation).toBe(true);
    const ignored = (capturedMessages ?? []).filter((m) => m.role === "tool" && String(m.content).includes("\"ignored\":true"));
    expect(ignored).toHaveLength(2);
    expect(result.booked).toBe(false);
    expect(result.reply).toContain("X-Burger");
  });

  it("aceita variações naturais da escolha ('opção 2', 'a primeira')", async () => {
    for (const choice of ["opção 2", "a primeira", "1️⃣"]) {
      capturedMessages = null;
      await think({ est: est(), kb: null, history: [...history.slice(0, 4), customer(choice)], contactPhone: "5511999990000", contactName: null, customerProfile: null, task: STALE_AGENDA_TASK, intent: OTHER });
      expect(systemContent()).toContain("ESCOLHA DE OPÇÃO DA SUA ÚLTIMA LISTA");
    }
  });

  it("lista vinda de FAQ (sem pedido explícito antes) não abre rascunho sozinha", async () => {
    scripted = [
      { content: null, tool_calls: [toolCall("t1", "add_order_item", { productId: "demo-prod-xburger", quantity: 1 })] },
      { content: "Certo!" },
    ];
    await think({
      est: est(), kb: null,
      history: [customer("o que vocês têm de lanche?"), bot(XBURGER_LIST), customer("1")],
      contactPhone: "5511999990000", contactName: null, customerProfile: null, task: null, intent: OTHER,
    });
    const addArgs = runToolMock.mock.calls.find((c) => c[0] === "add_order_item")?.[1] as Record<string, unknown>;
    expect(addArgs.__allowDraftCreation).toBeUndefined();
    expect(systemContent()).toContain("ESCOLHA DE OPÇÃO DA SUA ÚLTIMA LISTA");
  });
});

describe("F5.4 — agenda preservada: listas de horário e de serviço não mudam", () => {
  it("'1' respondendo a uma lista de HORÁRIOS continua no caminho determinístico da agenda", async () => {
    await think({
      est: est(), kb: null,
      history: [customer("quero marcar corte sexta"), bot("Tenho estes horários:\n1. 09:00\n2. 10:00\nQual prefere?"), customer("10")],
      contactPhone: "5511999990000", contactName: null, customerProfile: null,
      task: { ...STALE_AGENDA_TASK, state: "offer_options" }, intent: OTHER,
    });
    expect(runToolNames()).toContain("create_appointment");
    expect(systemContent()).not.toContain("ESCOLHA DE OPÇÃO DA SUA ÚLTIMA LISTA");
  });

  it("lista de SERVIÇOS da base não é tratada como lista de produtos", async () => {
    const kb = { services: [{ name: "Corte" }, { name: "Barba" }] } as unknown as KnowledgeBase;
    await think({
      est: est(), kb,
      history: [customer("quero marcar"), bot("Qual serviço?\n1. Corte\n2. Barba"), customer("1")],
      contactPhone: "5511999990000", contactName: null, customerProfile: null, task: null, intent: OTHER,
    });
    expect(systemContent()).not.toContain("ESCOLHA DE OPÇÃO DA SUA ÚLTIMA LISTA");
  });

  it("PEDIDO → AGENDA: novo pedido de agendamento com carrinho aberto ainda usa ferramentas de agenda", async () => {
    scripted = [
      { content: null, tool_calls: [toolCall("t1", "find_available_appointments", { date: "2026-10-02" })] },
      { content: "Tenho horários na sexta." },
    ];
    await think({
      est: est(), kb: null,
      history: [customer("quero um x-burger"), bot("Anotei 1 X-Burger."), customer("agora quero marcar um corte na sexta")],
      contactPhone: "5511999990000", contactName: null, customerProfile: null, task: null,
      intent: { type: "schedule_appointment", confidence: 0.9, entities: {} } as Intent,
    });
    expect(runToolNames()).toContain("find_available_appointments");
  });
});

describe("F5.4 — oferta de humano substituída por demanda nova", () => {
  const history = [
    customer("hum, ficou complicado neh, pois vc havia conferido na agenda e marcou, agora ja n tem mais ue"),
    bot("Posso chamar uma pessoa da equipe para te ajudar com isso?"),
    customer("quero o x-burger e 1 coca cola"),
  ];

  it("sem a capability human_handoff, tool/marcador do modelo não reabrem a oferta", async () => {
    const capabilities = { ...capabilitiesForConversation({ context: { purpose: "operational", source: "normal", enteredAt: 0, updatedAt: 0 }, bookingEnabled: true, ordersEnabled: true, demoAuthorized: false }), human_handoff: false };
    scripted = [
      { content: null, tool_calls: [toolCall("t1", "request_human_handoff", { reason: "irritação" })] },
      { content: "Vou chamar alguém. [[HANDOFF]]" },
    ];
    const result = await think({ est: est(), kb: null, history, contactPhone: "5511999990000", contactName: null, customerProfile: null, task: null, intent: OTHER, capabilities });
    expect(result.handoff).toBe(false);
    expect(result.reply).not.toContain("[[HANDOFF]]");
  });

  it("F4 preservado: com a capability, request_human_handoff continua sinalizando handoff", async () => {
    scripted = [
      { content: null, tool_calls: [toolCall("t1", "request_human_handoff", { reason: "cliente pediu humano" })] },
      { content: "Certo, vou chamar alguém da equipe." },
    ];
    const result = await think({
      est: est(), kb: null,
      history: [customer("quero falar com um atendente")],
      contactPhone: "5511999990000", contactName: null, customerProfile: null, task: null, intent: OTHER,
    });
    expect(result.handoff).toBe(true);
  });

  it("o prompt orienta resolver reclamação e atender pedido novo sem oferecer atendente", async () => {
    await think({ est: est(), kb: null, history, contactPhone: "5511999990000", contactName: null, customerProfile: null, task: null, intent: OTHER });
    const prompt = systemContent();
    expect(prompt).toContain("pedir um humano/atendente");
    expect(prompt).toContain("demonstrar irritação");
    expect(prompt).toContain("não é motivo para chamar atendente");
    expect(prompt).toContain("pedido novo e claro");
  });
});
