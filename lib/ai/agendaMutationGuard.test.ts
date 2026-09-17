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
    { type: "function", function: { name: "confirm_appointment", parameters: {} } },
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

function toolBatch(...calls: Array<{ name: string; args: Record<string, unknown>; id: string }>): ModelMessage {
  return {
    content: null,
    tool_calls: calls.map(({ name, args, id }) => ({ id, function: { name, arguments: JSON.stringify(args) } })),
  };
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
    expect(result.reply).toBe("Prontinho! Seu horário de Limpeza foi remarcado para 09/09 às 15:00.");
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
    expect(result.reply).toBe("Pronto, cancelei Limpeza de 10/09 às 10:00. Se quiser remarcar, é só me chamar.");
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
    expect(result.reply).toBe("Prontinho! Seu horário de Limpeza está reservado para 09/09 às 10:00.");
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

  it("REPRODUÇÃO: não pode aceitar texto que confirma a remarcação e inventa uma criação bloqueada", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "reschedule_appointment") {
        return { ok: true, data: { when: "09/09 às 15:00", serviceName: "Limpeza" } };
      }
      throw new Error("a criação bloqueada não deve chegar à tool");
    });
    modelMessages = [
      tool("create_appointment", { serviceName: "Avaliação", startAt: 1100 }),
      { content: "Seu horário foi remarcado para 09/09 às 15:00 e também agendei uma avaliação às 11:00." },
    ];

    const result = await run("Para quarta às 15h", task("reschedule_appointment"));

    expect(result.reply).toContain("15:00");
    expect(result.reply).not.toContain("11:00");
    expect(result.reply).not.toMatch(/também agendei/i);
    const modelCalls = create.mock.calls as unknown as Array<[{ messages: Array<{ role: string; content: string }> }]>;
    const secondModelRequest = modelCalls[1]![0];
    const blocked = secondModelRequest.messages.find((message) => message.role === "tool")!;
    expect(JSON.parse(blocked.content)).toMatchObject({ ok: false, ignored: true });
  });

  it("REPRODUÇÃO OT-02F: não pode inventar segunda operação sem nova tool call", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "reschedule_appointment") {
        return { ok: true, data: { when: "09/09 às 15:00", serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });
    modelMessages = [{ content: "Pronto! Foi remarcado para 09/09 às 15:00 e também agendei sua Avaliação para 09/09 às 11:00." }];

    const result = await run("Para quarta às 15h", task("reschedule_appointment"));

    expect(result.reply).toContain("15:00");
    expect(result.reply).not.toContain("11:00");
    expect(result.reply).not.toMatch(/avaliação/i);
  });

  it.each([
    "Seu horário jamais foi remarcado para 09/09 às 15:00.",
    "Foi remarcado para 09/09 às 15:00, mas sem sucesso na verdade.",
  ])("REPRODUÇÃO OT-02F: canonicaliza negação alternativa: %s", async (modelReply) => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "reschedule_appointment") {
        return { ok: true, data: { when: "09/09 às 15:00", serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });
    modelMessages = [{ content: modelReply }];

    const result = await run("Para quarta às 15h", task("reschedule_appointment"));

    expect(result.reply).toBe("Prontinho! Seu horário de Limpeza foi remarcado para 09/09 às 15:00.");
  });

  it("REPRODUÇÃO OT-02F: stalling posterior não pode ocultar a remarcação em handoff", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "reschedule_appointment") {
        return { ok: true, data: { when: "09/09 às 15:00", serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });
    modelMessages = [
      { content: "Remarcado para 09/09 às 15:00, um momento." },
      { content: "Remarcado para 09/09 às 15:00, um momento." },
    ];

    const result = await run("Para quarta às 15h", task("reschedule_appointment"));

    expect(result.reply).toBe("Prontinho! Seu horário de Limpeza foi remarcado para 09/09 às 15:00.");
    expect(result.handoff).toBe(false);
  });

  it("REPRODUÇÃO: não pode aceitar negação da operação real apenas porque contém a data correta", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "reschedule_appointment") {
        return { ok: true, data: { when: "09/09 às 15:00", serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });
    modelMessages = [{ content: "Infelizmente seu horário não foi remarcado para 09/09 às 15:00." }];

    const result = await run("Para quarta às 15h", task("reschedule_appointment"));

    expect(result.reply).not.toMatch(/não foi remarcado/i);
    expect(result.reply).toMatch(/foi remarcado/i);
  });

  it("substitui negações de criação e cancelamento pelo estado real", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "create_appointment") {
        return { ok: true, data: { when: "09/09 às 10:00", serviceName: "Limpeza" } };
      }
      return { ok: true, data: { serviceName: "Limpeza", when: "10/09 às 10:00" } };
    });
    modelMessages = [{ content: "Não consegui agendar sua limpeza para 09/09 às 10:00." }];
    const created = await run("Pode ser às 10h", task("schedule_appointment"));

    expect(created.reply).toContain("10:00");
    expect(created.reply).not.toMatch(/não consegui agendar/i);

    vi.clearAllMocks();
    modelMessages = [{ content: "Seu agendamento não foi cancelado." }];
    const cancelTask = { ...task("cancel_appointment", { appointmentId: "appt-1" }), state: "confirm" as const };
    const cancelled = await run("Sim", cancelTask);

    expect(cancelled.reply).toMatch(/cancelei/i);
    expect(cancelled.reply).not.toMatch(/não foi cancelado/i);
  });

  it("não permite que uma criação real seja seguida de cancelamento inventado", async () => {
    let status = "none";
    runTool.mockImplementation(async (name: string) => {
      if (name === "create_appointment") {
        status = "pending";
        return { ok: true, data: { when: "09/09 às 10:00", serviceName: "Limpeza" } };
      }
      throw new Error("o cancelamento bloqueado não deve chegar à tool");
    });
    modelMessages = [
      tool("cancel_appointment", { appointmentId: "appt-1" }),
      { content: "Criei seu horário e também o cancelei." },
    ];

    const result = await run("Pode ser às 10h", task("schedule_appointment"));

    expect(status).toBe("pending");
    expect(runTool.mock.calls.filter(([name]) => name === "cancel_appointment")).toHaveLength(0);
    expect(result.reply).toContain("10:00");
    expect(result.reply).not.toMatch(/cancelei/i);
  });

  it("não permite que um cancelamento real seja seguido de criação inventada", async () => {
    let status = "pending";
    runTool.mockImplementation(async (name: string) => {
      if (name === "cancel_appointment") {
        status = "cancelled";
        return { ok: true, data: { serviceName: "Limpeza", when: "10/09 às 10:00" } };
      }
      throw new Error("a criação bloqueada não deve chegar à tool");
    });
    modelMessages = [
      tool("create_appointment", { serviceName: "Avaliação", startAt: 1100 }),
      { content: "Cancelei sua limpeza e criei uma avaliação." },
    ];
    const cancelTask = { ...task("cancel_appointment", { appointmentId: "appt-1" }), state: "confirm" as const };

    const result = await run("Sim, e marque outro às 14h", cancelTask);

    expect(status).toBe("cancelled");
    expect(runTool.mock.calls.filter(([name]) => name === "create_appointment")).toHaveLength(0);
    expect(result.reply).toMatch(/cancelei/i);
    expect(result.reply).not.toMatch(/criei/i);
    expect(result.reply).toMatch(/outro agendamento não foi criado/i);
  });

  it("bloqueia duas mutações na mesma resposta do modelo após a primeira bem-sucedida", async () => {
    const writes: string[] = [];
    runTool.mockImplementation(async (name: string) => {
      if (name === "create_appointment") {
        writes.push("create");
        return { ok: true, data: { when: "09/09 às 10:00", serviceName: "Limpeza" } };
      }
      throw new Error(`a segunda escrita ${name} não deve executar`);
    });
    modelMessages = [
      toolBatch(
        { id: "create-1", name: "create_appointment", args: { serviceName: "Limpeza", startAt: 1000 } },
        { id: "cancel-2", name: "cancel_appointment", args: { appointmentId: "appt-1" } },
      ),
      { content: "Agendei e cancelei." },
    ];

    const result = await run("Quero agendar", null);

    expect(writes).toEqual(["create"]);
    expect(result.reply).toContain("10:00");
    expect(result.reply).not.toMatch(/cancelei/i);
  });

  it("bloqueia confirm_appointment depois de uma criação, pois também altera a agenda", async () => {
    let status = "none";
    runTool.mockImplementation(async (name: string) => {
      if (name === "create_appointment") {
        status = "pending";
        return { ok: true, data: { when: "09/09 às 10:00", serviceName: "Limpeza" } };
      }
      throw new Error("a confirmação bloqueada não deve chegar à tool");
    });
    modelMessages = [tool("confirm_appointment", { appointmentId: "appt-1" }), { content: "Confirmei sua presença." }];

    const result = await run("Pode ser às 10h", task("schedule_appointment"));

    expect(status).toBe("pending");
    expect(runTool.mock.calls.filter(([name]) => name === "confirm_appointment")).toHaveLength(0);
    expect(result.reply).toContain("10:00");
  });

  it("permite confirmação como primeira escrita e bloqueia criação posterior", async () => {
    let status = "pending";
    runTool.mockImplementation(async (name: string) => {
      if (name === "confirm_appointment") {
        status = "confirmed";
        return { ok: true, data: { when: "10/09 às 10:00", serviceName: "Limpeza" } };
      }
      throw new Error("a criação posterior deve ser bloqueada");
    });
    modelMessages = [
      tool("confirm_appointment", { appointmentId: "appt-1" }),
      tool("create_appointment", { serviceName: "Avaliação", startAt: 1100 }),
      { content: "Confirmei e criei uma avaliação." },
    ];

    const result = await run("Confirmo minha presença", null);

    expect(status).toBe("confirmed");
    expect(result.agendaMutationCompleted).toBe(true);
    expect(runTool.mock.calls.filter(([name]) => name === "create_appointment")).toHaveLength(0);
    expect(result.reply).toMatch(/presença.*confirmada/i);
    expect(result.reply).not.toMatch(/avaliação/i);
  });

  it("fecha uma confirmação bem-sucedida com os dados reais da tool", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "confirm_appointment") {
        return { ok: true, data: { when: "10/09 às 10:00", serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });
    modelMessages = [
      tool("confirm_appointment", { appointmentId: "appt-1" }),
      { content: "Tudo certo com seu horário." },
    ];

    const result = await run("Confirmo minha presença", null);

    expect(result.reply).toBe("Prontinho! Sua presença para Limpeza em 10/09 às 10:00 está confirmada.");
  });

  it("preserva handoff explícito sem ocultar o fato já persistido", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "reschedule_appointment") {
        return { ok: true, data: { when: "09/09 às 15:00", serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });
    modelMessages = [{ content: "Vou chamar a equipe. [[HANDOFF]]" }];

    const result = await run("Para quarta às 15h", task("reschedule_appointment"));

    expect(result.reply).toBe("Prontinho! Seu horário de Limpeza foi remarcado para 09/09 às 15:00.");
    expect(result.handoff).toBe(true);
  });

  it("mantém resposta natural do modelo quando nenhuma mutação ocorreu", async () => {
    modelMessages = [{ content: "Claro! Como posso ajudar você hoje?" }];

    const result = await run("Oi", null);

    expect(result.reply).toBe("Claro! Como posso ajudar você hoje?");
    expect(result.booked).toBe(false);
    expect(result.rescheduled).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.agendaMutationCompleted).toBe(false);
  });
});

describe("correções explícitas de data e horário", () => {
  it.each([
    ["quis dizer 10h", "10:00", "2026-09-09T13:00:00.000Z"],
    ["na verdade 15h", "15:00", "2026-09-09T18:00:00.000Z"],
    ["corrigindo, 14h", "14:00", "2026-09-09T17:00:00.000Z"],
  ])("%s preserva a data ativa e usa %s", async (text, time, expectedIso) => {
    runTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "create_appointment") {
        return { ok: true, data: { when: `09/09 às ${time}`, serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });

    const result = await run(text, task("schedule_appointment"));

    expect(runTool).toHaveBeenCalledWith(
      "create_appointment",
      expect.objectContaining({ startAt: Date.parse(expectedIso) }),
      expect.anything(),
    );
    expect(result.booked).toBe(true);
    expect(result.reply).toContain(time);
  });

  it("horário corrigido sem contexto não cria ação", async () => {
    const result = await run("quis dizer 10h", null);

    expect(result.booked).toBe(false);
    expect(
      runTool.mock.calls.some(([name]) =>
        ["create_appointment", "reschedule_appointment", "cancel_appointment", "confirm_appointment"].includes(name),
      ),
    ).toBe(false);
  });

  it("correção só de data atualiza statedDate sem causar mutação", async () => {
    const result = await run("na verdade sexta", task("schedule_appointment"));

    expect(result.statedDate).toBe("2026-09-11");
    expect(result.booked).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("corrigindo dia 18 às 10 mantém o comportamento já correto", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "create_appointment") {
        return { ok: true, data: { when: "18/09 às 10:00", serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });

    const result = await run("corrigindo, dia 18 às 10", task("schedule_appointment"));

    expect(runTool).toHaveBeenCalledWith(
      "create_appointment",
      expect.objectContaining({ startAt: Date.parse("2026-09-18T13:00:00.000Z") }),
      expect.anything(),
    );
    expect(result.booked).toBe(true);
  });

  it("segunda mutação continua bloqueada após correção de horário", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "create_appointment") {
        return { ok: true, data: { when: "09/09 às 10:00", serviceName: "Limpeza" } };
      }
      throw new Error("a segunda mutação não deve chegar à tool");
    });
    modelMessages = [tool("cancel_appointment", { appointmentId: "appt-1" }), { content: "feito" }];

    const result = await run("quis dizer 10h", task("schedule_appointment"));

    expect(runTool.mock.calls.filter(([name]) => name === "create_appointment")).toHaveLength(1);
    expect(runTool.mock.calls.filter(([name]) => name === "cancel_appointment")).toHaveLength(0);
    expect(result.reply).toContain("10:00");
  });

  it("correção de horário preserva appointmentId já selecionado", async () => {
    runTool.mockImplementation(async (name: string) => {
      if (name === "reschedule_appointment") {
        return { ok: true, data: { when: "09/09 às 10:00", serviceName: "Limpeza" } };
      }
      return { ok: true, data: {} };
    });

    const result = await run(
      "quis dizer 10h",
      task("reschedule_appointment", { appointmentId: "appt-alvo" }),
    );

    expect(runTool).toHaveBeenCalledWith(
      "reschedule_appointment",
      expect.objectContaining({ appointmentId: "appt-alvo" }),
      expect.anything(),
    );
    expect(result.rescheduled).toBe(true);
  });
});
