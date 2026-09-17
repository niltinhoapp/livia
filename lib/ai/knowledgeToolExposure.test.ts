import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Establishment, Intent, KnowledgeBase } from "@/types";
import type { ToolContext } from "@/lib/ai/tools";

let completionInput: {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.ChatCompletionTool[];
} | null = null;

vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: typeof completionInput) => {
    completionInput = input;
    return { content: "A avaliação custa R$ 120.", tool_calls: undefined };
  }),
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: vi.fn(async (establishmentId: string) => ({
    establishmentId,
    utcOffsetMinutes: -180,
    defaultDurationMin: 30,
    slotMinutes: 30,
    days: {},
  })),
  localToEpoch: vi.fn(),
  assertBookable: vi.fn(),
}));

vi.mock("@/lib/repo", () => ({
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(async () => undefined),
}));

const { think } = await import("./brain");
const { toolsFor } = await import("./tools");

const est = {
  id: "est-1",
  name: "Clínica Exemplo",
  bot: {
    personaName: "Livia",
    tone: "acolhedora",
    bookingEnabled: true,
    handoffKeywords: [],
    medicalGuardrail: false,
  },
} as unknown as Establishment;

const kb: KnowledgeBase = {
  establishmentId: est.id,
  about: "Clínica odontológica",
  address: "Rua das Flores, 10",
  hours: "Segunda a sexta, das 8h às 18h",
  services: [{
    name: "Avaliação",
    priceText: "R$ 120",
    durationText: "40 minutos",
    description: "Consulta inicial completa",
  }],
  faqs: [{ question: "Aceita cartão?", answer: "Sim, em até 3 vezes." }],
  notes: "Estacionamento conveniado ao lado.",
  paymentMethods: "Pix e cartão",
  importantInfo: "Chegar com 10 minutos de antecedência.",
  toneGuidelines: null,
  prohibitions: null,
  handoffTriggers: null,
  updatedAt: 0,
};

function toolContext(): ToolContext {
  return {
    est,
    kb,
    config: null,
    contactPhone: "5511999999999",
    contactName: "Cliente",
    offset: -180,
    customerProfile: null,
  };
}

function toolNames(): string[] {
  return toolsFor(toolContext()).map((tool) => tool.function.name);
}

beforeEach(() => {
  completionInput = null;
});

describe("OT-IA-02 — conhecimento no prompt sem tool redundante", () => {
  it("não disponibiliza search_knowledge_base ao modelo", () => {
    expect(toolNames()).not.toContain("search_knowledge_base");
  });

  it("mantém todas as demais tools disponíveis", () => {
    expect(toolNames()).toEqual([
      "get_business_hours",
      "get_customer_profile",
      "update_customer_profile",
      "get_customer_appointments",
      "find_available_appointments",
      "create_appointment",
      "confirm_appointment",
      "reschedule_appointment",
      "cancel_appointment",
      "request_human_handoff",
    ]);
  });

  it("mantém no prompt todo conhecimento antes pesquisável pela tool", async () => {
    const intent: Intent = { type: "ask_price", confidence: 0.9, entities: {} };
    const estWithoutBooking = {
      ...est,
      bot: { ...est.bot, bookingEnabled: false },
    };
    await think({
      est: estWithoutBooking,
      kb,
      history: [{ id: "1", role: "customer", text: "Quanto custa a avaliação?", at: Date.now() }],
      contactPhone: "5511999999999",
      contactName: "Cliente",
      customerProfile: null,
      task: null,
      intent,
    });

    const captured = completionInput as typeof completionInput;
    const systemPrompt = captured?.messages.find((message) => message.role === "system")?.content;
    expect(systemPrompt).toEqual(expect.stringContaining("Avaliação | preço: R$ 120 | duração: 40 minutos | Consulta inicial completa"));
    expect(systemPrompt).toEqual(expect.stringContaining("P: Aceita cartão?\nR: Sim, em até 3 vezes."));
    expect(systemPrompt).toEqual(expect.stringContaining("Observações: Estacionamento conveniado ao lado."));
    expect(captured?.tools?.map((tool) => tool.function.name)).not.toContain("search_knowledge_base");
  });
});
