// Guarda de agenda por turno: reproduz o caminho completo de think(),
// incluindo uma mutação determinística antes do loop e tool calls posteriores
// geradas pelo modelo. Nenhuma chamada usa Firestore ou OpenAI reais.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTask, Establishment, Intent } from "@/types";

const OFFSET = -180;
const AGORA = new Date("2026-09-06T17:00:00.000Z").getTime();

type ModelMessage = { content: string | null; tool_calls?: unknown[] };
let modelMessages: ModelMessage[] = [];
const create = vi.fn(async () => ({ choices: [{ message: modelMessages.shift() ?? { content: "ok" } }] }));

vi.mock("openai", () => ({ default: class { chat = { completions: { create } }; } }));
vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: OFFSET, defaultDurationMin: 30, days: {} }),
  localToEpoch: (date: string, minutes: number, offset: number) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year!, month! - 1, day!) + minutes * 60000 - offset * 60000;
  },
  assertBookable: async () => null,
}));

const runTool = vi.fn();
vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [
    { type: "function", function: { name: "create_appointment", parameters: {} } },
    { type: "function", function: { name: "reschedule_appointment", parameters: {} } },
    { type: "function", function: { name: "cancel_appointment", parameters: {} } },
    { type: "function", function: { name: "get_business_hours", parameters: {} } },
  ],
  runTool: (...args: unknown[]) => runTool(...args),
}));

const { think } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const intent: Intent = { type: "general_question", confidence: 0.4, entities: {} };

function task(type: ConversationTask["type"], data: Record<string, unknown> = {}): ConversationTask {
  return { type, state: "offer_options", collectedData: { date: "2026-09-09", serviceName: "Limpeza", ...data }, missingData: [], updatedAt: AGORA };
}

function tool(name: string, args: Record<string, unknown>, id = `call-${name}`): ModelMessage {
  return { content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] };
}

async function run(text: string, currentTask: ConversationTask | null) {
  return think({
    est, kb: null,
    history: [{ id: "customer", role: "customer", text, at: AGORA }],
    contactPhone: "5514990000000", contactName: "Carla", customerProfile: null, task: currentTask, intent,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
  modelMessages = [];
  runTool.mockResolvedValue({ ok: true, data: {} });
});

describe("uma mutação de agenda bem-sucedida por turno", () => {
  it("mantém a remarcação determinística às 15:00 e bloqueia a segunda chamada do modelo", async () => {
    let finalTime = "";
    runTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "reschedule_appointment") {
        finalTime = finalTime ? "09:20" : "15:00";
        return { ok: true, data: { when: `09/09 às ${finalTime}`, serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });
    modelMessages = [tool("reschedule_appointment", { newStartAt: 920 }), { content: "Remarquei para 09:20" }];

    const result = await run("Para quarta às 15h", task("reschedule_appointment"));

    expect(runTool.mock.calls.filter(([name]) => name === "reschedule_appointment")).toHaveLength(1);
    expect(finalTime).toBe("15:00");
    expect(result.reply).toContain("15:00");
    expect(result.reply).not.toContain("09:20");
  });

  it("cancela uma vez e não expõe 'já estava cancelado' após segunda tentativa", async () => {
    let status = "pending";
    runTool.mockImplementation(async (name: string) => {
      if (name === "cancel_appointment") {
        status = "cancelled";
        return { ok: true, data: { serviceName: "Limpeza", when: "10/09 às 10:00" } };
      }
      return { ok: true, data: {} };
    });
    modelMessages = [tool("cancel_appointment", { appointmentId: "appt-1" }), { content: "Já estava cancelado." }];
    const cancelTask = { ...task("cancel_appointment", { appointmentId: "appt-1" }), state: "confirm" as const };

    const result = await run("Sim", cancelTask);

    expect(runTool.mock.calls.filter(([name]) => name === "cancel_appointment")).toHaveLength(1);
    expect(status).toBe("cancelled");
    expect(result.reply).toMatch(/cancelei/i);
    expect(result.reply).not.toMatch(/já estava/i);
  });

  it("cria uma vez e confirma o horário efetivamente criado", async () => {
    const created: string[] = [];
    runTool.mockImplementation(async (name: string) => {
      if (name === "create_appointment") {
        created.push(created.length === 0 ? "10:00" : "11:00");
        return { ok: true, data: { when: `09/09 às ${created.at(-1)}`, serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });
    modelMessages = [tool("create_appointment", { serviceName: "Limpeza", startAt: 1100 }), { content: "Agendei para 11:00" }];

    const result = await run("Pode ser às 10h", task("schedule_appointment"));

    expect(runTool.mock.calls.filter(([name]) => name === "create_appointment")).toHaveLength(1);
    expect(created).toEqual(["10:00"]);
    expect(result.reply).toContain("10:00");
    expect(result.reply).not.toContain("11:00");
  });

  it("continua permitindo consulta read-only depois da mutação", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "reschedule_appointment") return { ok: true, data: { when: "09/09 às 15:00", serviceName: "Limpeza" } };
      if (name === "get_business_hours") return { ok: true, data: { open: true } };
      return { ok: true, data: {} };
    });
    modelMessages = [
      tool("get_business_hours", { date: "2026-09-09" }),
      tool("reschedule_appointment", { newStartAt: 920 }),
      { content: "Tudo certo" },
    ];

    await run("Para quarta às 15h", task("reschedule_appointment"));

    expect(runTool).toHaveBeenCalledWith("get_business_hours", { date: "2026-09-09" }, expect.anything());
    expect(runTool.mock.calls.filter(([name]) => name === "reschedule_appointment")).toHaveLength(1);
  });

  it("não consome a guarda quando a primeira mutação falha", async () => {
    let attempts = 0;
    runTool.mockImplementation(async (name: string) => {
      if (name === "create_appointment") {
        attempts++;
        return attempts === 1
          ? { ok: false, error: "horário indisponível" }
          : { ok: true, data: { when: "09/09 às 11:00", serviceName: "Limpeza" } };
      }
      if (name === "find_available_appointments") return { ok: true, data: { slots: [] } };
      return { ok: true, data: {} };
    });
    modelMessages = [tool("create_appointment", { serviceName: "Limpeza", startAt: 1100 }), { content: "Agendado" }];

    const result = await run("Pode ser às 10h", task("schedule_appointment"));

    expect(runTool.mock.calls.filter(([name]) => name === "create_appointment")).toHaveLength(2);
    expect(result.booked).toBe(true);
    expect(result.reply).toContain("11:00");
  });

  it("bloqueia a segunda escrita mesmo se a tool bem-sucedida retornar metadata incompleta", async () => {
    runTool.mockResolvedValue({ ok: true, data: {} });
    modelMessages = [
      tool("create_appointment", { serviceName: "Limpeza", startAt: 1000 }, "create-1"),
      tool("create_appointment", { serviceName: "Limpeza", startAt: 1100 }, "create-2"),
      { content: "Agendei para 11:00" },
    ];

    const result = await run("Quero agendar uma limpeza", null);

    expect(runTool.mock.calls.filter(([name]) => name === "create_appointment")).toHaveLength(1);
    expect(result.reply).toBe("Prontinho! Seu agendamento foi confirmado.");
  });
});
