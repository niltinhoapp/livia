import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Establishment, KnowledgeBase, Message } from "@/types";
import type { ToolContext } from "@/lib/ai/tools";

let completionInput: {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.ChatCompletionTool[];
} | null = null;

vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: typeof completionInput) => {
    completionInput = input;
    return { content: "Que ótimo que você fez a Auditoria!", tool_calls: undefined };
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
  services: [{ name: "Avaliação", priceText: "R$ 120", durationText: "40 minutos", description: "Consulta inicial" }],
  faqs: [],
  notes: "",
  paymentMethods: "Pix",
  importantInfo: "Chegar com 10 minutos de antecedência.",
  toneGuidelines: null,
  prohibitions: null,
  handoffTriggers: null,
  updatedAt: 0,
};

const SCHEDULING_TOOLS = [
  "find_available_appointments",
  "create_appointment",
  "confirm_appointment",
  "reschedule_appointment",
  "cancel_appointment",
  "get_customer_appointments",
  "get_business_hours",
];

function toolNames(ctx: Partial<ToolContext> = {}): string[] {
  return toolsFor({
    est,
    kb,
    config: null,
    contactPhone: "5511999999999",
    contactName: "Cliente",
    offset: -180,
    customerProfile: null,
    ...ctx,
  }).map((tool) => tool.function.name);
}

beforeEach(() => {
  completionInput = null;
});

describe("audit context boundary — tools", () => {
  it("suppressBooking=true removes all scheduling tools", () => {
    const names = toolNames({ suppressBooking: true });
    for (const tool of SCHEDULING_TOOLS) {
      expect(names).not.toContain(tool);
    }
  });

  it("suppressBooking=false (default) keeps all scheduling tools", () => {
    const names = toolNames();
    for (const tool of SCHEDULING_TOOLS) {
      expect(names).toContain(tool);
    }
  });

  it("non-scheduling tools remain available during audit", () => {
    const names = toolNames({ suppressBooking: true });
    expect(names).toContain("get_customer_profile");
    expect(names).toContain("update_customer_profile");
    expect(names).toContain("request_human_handoff");
  });
});

describe("audit context boundary — system prompt via think()", () => {
  const auditMessage: Message = {
    id: "m-audit",
    role: "customer",
    text: "Acabei de fazer a Auditoria de Atendimento. Leads por dia: 10 Ticket médio: R$ 259",
    at: 1,
  };

  it("suppressBooking=true: no scheduling instructions in prompt", async () => {
    await think({
      est,
      kb,
      history: [auditMessage],
      contactPhone: "5511999999999",
      contactName: "Cliente",
      customerProfile: null,
      task: null,
      intent: { type: "general_question", confidence: 0.5, entities: {} },
      suppressBooking: true,
    });

    const systemMsg = completionInput?.messages.find((m) => m.role === "system");
    const prompt = typeof systemMsg?.content === "string" ? systemMsg.content : "";
    expect(prompt).not.toContain("find_available_appointments");
    expect(prompt).not.toContain("create_appointment");
    expect(prompt).not.toContain("get_customer_appointments");
    expect(prompt).not.toContain("Você PODE agendar");
    expect(prompt).not.toContain("Descubra o serviço desejado");
    expect(prompt).not.toContain("ainda não fecha agendamentos");
    expect(prompt).toContain("Clínica Exemplo");
    expect(prompt).toContain("Chegar com 10 minutos de antecedência");
  });

  it("suppressBooking=true: no scheduling tools in tool list", async () => {
    await think({
      est,
      kb,
      history: [auditMessage],
      contactPhone: "5511999999999",
      contactName: "Cliente",
      customerProfile: null,
      task: null,
      intent: { type: "general_question", confidence: 0.5, entities: {} },
      suppressBooking: true,
    });

    const toolNames = completionInput?.tools?.map((t) => t.function.name) ?? [];
    for (const tool of SCHEDULING_TOOLS) {
      expect(toolNames).not.toContain(tool);
    }
  });

  it("without suppressBooking: scheduling instructions present in prompt", async () => {
    await think({
      est,
      kb,
      history: [{ id: "m-normal", role: "customer", text: "Tem horário amanhã?", at: 1 }],
      contactPhone: "5511999999999",
      contactName: "Cliente",
      customerProfile: null,
      task: null,
      intent: { type: "general_question", confidence: 0.5, entities: {} },
    });

    const systemMsg = completionInput?.messages.find((m) => m.role === "system");
    const prompt = typeof systemMsg?.content === "string" ? systemMsg.content : "";
    expect(prompt).toContain("Você PODE agendar");
    expect(prompt).toContain("get_customer_appointments");
  });

  it("without suppressBooking: scheduling tools present", async () => {
    await think({
      est,
      kb,
      history: [{ id: "m-normal", role: "customer", text: "Quero marcar uma consulta", at: 1 }],
      contactPhone: "5511999999999",
      contactName: "Cliente",
      customerProfile: null,
      task: null,
      intent: { type: "schedule_appointment", confidence: 0.9, entities: {} },
    });

    const toolNames = completionInput?.tools?.map((t) => t.function.name) ?? [];
    for (const tool of SCHEDULING_TOOLS) {
      expect(toolNames).toContain(tool);
    }
  });
});

describe("audit context boundary — scheduling regression", () => {
  it("'Qual horário eu marquei?' still gets scheduling tools (no suppressBooking)", async () => {
    await think({
      est,
      kb,
      history: [{ id: "m-check", role: "customer", text: "Qual horário eu marquei?", at: 1 }],
      contactPhone: "5511999999999",
      contactName: "Cliente",
      customerProfile: null,
      task: null,
      intent: { type: "check_appointment", confidence: 0.9, entities: {} },
    });

    const toolNames = completionInput?.tools?.map((t) => t.function.name) ?? [];
    expect(toolNames).toContain("get_customer_appointments");
    expect(toolNames).toContain("find_available_appointments");
  });

  it("'Tem horário amanhã?' keeps find_available_appointments", async () => {
    await think({
      est,
      kb,
      history: [{ id: "m-avail", role: "customer", text: "Tem horário amanhã?", at: 1 }],
      contactPhone: "5511999999999",
      contactName: "Cliente",
      customerProfile: null,
      task: null,
      intent: { type: "schedule_appointment", confidence: 0.8, entities: {} },
    });

    const toolNames = completionInput?.tools?.map((t) => t.function.name) ?? [];
    expect(toolNames).toContain("find_available_appointments");
    expect(toolNames).toContain("create_appointment");
  });
});
