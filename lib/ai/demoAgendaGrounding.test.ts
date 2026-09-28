// A agenda oficial da demo só pode oferecer slots que o backend consultou.
// Reproduz o caso real: a primeira data está fechada, o cérebro encontra a
// próxima data demonstrável e a escolha posterior chega ao create real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationContext, ConversationTask, Establishment, Intent } from "@/types";
import { capabilitiesForConversation } from "./conversationPolicy";

type ModelMessage = { content?: string; tool_calls?: unknown[] };
let answers: ModelMessage[] = [];
const completion = vi.fn(async () => ({ choices: [{ message: answers.shift() ?? { content: "" } }] }));
let reserved = false;
const runTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === "find_available_appointments") {
    if (args.date === "2026-09-06") return { ok: true, data: { date: args.date, slots: [] } };
    return { ok: true, data: { date: args.date, slots: reserved ? [] : [{ time: "10:00", startAt: 1 }] } };
  }
  if (name === "create_appointment") {
    reserved = true;
    return { ok: true, data: { when: "07/09 às 10:00", serviceName: "Corte" } };
  }
  return { ok: true, data: {} };
});

vi.mock("openai", () => ({
  default: class { chat = { completions: { create: completion } }; },
}));
vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: -180, defaultDurationMin: 30, leadHours: 0, days: {} }),
  localToEpoch: (date: string, minutes: number, offset: number) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year!, month! - 1, day!, 0, minutes) - offset * 60_000;
  },
  assertBookable: async () => null,
  demoSlots: (prospectingLeadId: string) => ({ kind: "demo", prospectingLeadId }),
  PRODUCTION_SLOTS: { kind: "production" },
}));
vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [{ type: "function", function: { name: "find_available_appointments", parameters: {} } }],
  runTool: (...args: unknown[]) => runTool(...(args as [string, Record<string, unknown>])),
}));

const { think } = await import("./brain");

const est = {
  id: "official-demo",
  name: "Demo",
  demoChannel: { enabled: true },
  bot: { personaName: "Lívia", tone: "objetiva", bookingEnabled: true, ordersEnabled: false, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const context: ConversationContext = {
  purpose: "commercial", source: "audit_calculator", enteredAt: 1, updatedAt: 1,
  commercial: { segment: "salon", segmentIdentifiedAt: 1 },
};
const authorization = { authorized: true as const, establishmentId: est.id, prospectingLeadId: "lead-demo" };
const intent: Intent = { type: "general_question", confidence: 1, entities: {} };

function input(text: string, task: ConversationTask | null = null) {
  return {
    est, kb: { establishmentId: est.id, about: "", address: null, hours: null, services: [{ name: "Corte", priceText: null, durationText: "30 min", description: null }], faqs: [], notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0 } as never,
    history: [{ id: "customer", role: "customer" as const, text, at: Date.now() }],
    contactPhone: "5511900000001", contactName: "Prospect", customerProfile: null, task, intent,
    prospectingContext: { status: "INTERESTED", leadId: "lead-demo", segment: "salão" } as never,
    demoAuthorization: authorization, conversationContext: context,
    capabilities: capabilitiesForConversation({ context, bookingEnabled: true, ordersEnabled: false, demoAuthorized: true }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reserved = false;
  vi.setSystemTime(new Date("2026-09-06T15:00:00.000Z"));
  answers = [];
});

describe("agenda demo grounded", () => {
  it("data fechada consulta a próxima vaga real, sem oferecer amanhã por palpite", async () => {
    answers = [
      { tool_calls: [{ id: "availability", function: { name: "find_available_appointments", arguments: '{"date":"2026-09-06","serviceName":"Corte"}' } }] },
      { content: "O próximo horário real é 07/09 às 10:00. Qual prefere?" },
    ];

    const result = await think(input("Corte"));

    expect(runTool).toHaveBeenCalledWith("find_available_appointments", { date: "2026-09-06", serviceName: "Corte" }, expect.anything());
    expect(runTool).toHaveBeenCalledWith("find_available_appointments", { date: "2026-09-07", serviceName: "Corte" }, expect.anything());
    expect(result.toolCalls.map((call) => call.args.date)).toContain("2026-09-07");
    expect(result.reply).toContain("10:00");
  });

  it("não deixa o modelo afirmar vagas sem uma consulta positiva", async () => {
    answers = [
      { content: "Para corte amanhã, eu já tenho opções disponíveis: qual horário você prefere?" },
      { tool_calls: [{ id: "availability", function: { name: "find_available_appointments", arguments: '{"date":"2026-09-07","serviceName":"Corte"}' } }] },
      { content: "Para 07/09, encontrei 10:00. Qual prefere?" },
    ];

    const result = await think(input("Corte"));

    expect(completion).toHaveBeenCalledTimes(3);
    const secondRequest = (completion.mock.calls as unknown as [{ messages: { role: string; content: string }[] }][])[1]![0]!;
    const correction = secondRequest.messages
      .findLast((message) => message.role === "system" && /nenhuma consulta positiva/i.test(message.content))!;
    expect(correction.content).toMatch(/nenhuma consulta positiva/i);
    expect(result.reply).toContain("10:00");
  });

  it("horário que veio da disponibilidade real é criado e deixa de aparecer", async () => {
    const task: ConversationTask = { type: "schedule_appointment", state: "offer_options", collectedData: { date: "2026-09-07", serviceName: "Corte" }, missingData: [], updatedAt: Date.now() };
    answers = [{ content: "Prontinho! Seu horário está reservado." }];

    const result = await think(input("As 10", task));

    expect(runTool).toHaveBeenCalledWith("create_appointment", expect.objectContaining({ serviceName: "Corte" }), expect.anything());
    expect(result.booked).toBe(true);
    expect(result.reply).toContain("reservado");
    expect(await runTool("find_available_appointments", { date: "2026-09-07" })).toMatchObject({ data: { slots: [] } });
  });
});
