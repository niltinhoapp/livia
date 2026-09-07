// Auditoria 06/09/2026 — correções P1 e P2 (ver
// docs/AUDITORIA-INTELIGENCIA-2026-09-06.md).
//
// P2 (F2, CRÍTICO, latente): o caminho determinístico de escolha de horário
// aceitava tarefas de REMARCAÇÃO mas chamava create_appointment — criava um
// segundo agendamento e deixava o antigo ativo.
//
// P1 (F1, CRÍTICO, observado): quando o modelo gastava as 4 iterações do loop
// de ferramentas sem produzir texto, o sistema transferia para humano
// incondicionalmente. Foi o que a cliente Rejane recebeu às 20:38 ao pedir
// "as 14h" — com a agenda funcionando o tempo todo. Identificado pela
// assinatura textual: aquela frase existe só no retorno de estouro do loop.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTask, Establishment, Intent } from "@/types";

const OFFSET = -180;
const AGORA = new Date("2026-09-06T17:00:00.000Z").getTime();

// Cada item vira uma resposta do modelo. `toolCalls` força o loop a continuar.
type RespostaFake = { content: string | null; tool_calls?: unknown[] };
let respostas: RespostaFake[] = [];

const create = vi.fn(async (_params?: unknown) => ({
  choices: [{ message: respostas.shift() ?? { content: "ok" } }],
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: OFFSET, defaultDurationMin: 30, days: {} }),
  localToEpoch: (dateStr: string, minutos: number, offset: number) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!) + minutos * 60000 - offset * 60000;
  },
  assertBookable: async () => null,
}));

const runTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === "reschedule_appointment") {
    return { ok: true, data: { when: "07/09 às 14:00", serviceName: "Avaliação" } };
  }
  if (name === "create_appointment") {
    return { ok: true, data: { when: "07/09 às 14:00", serviceName: args.serviceName } };
  }
  if (name === "find_available_appointments") {
    return { ok: true, data: { date: args.date, slots: [{ time: "14:30" }, { time: "15:00" }] } };
  }
  return { ok: true, data: {} };
});

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [{ type: "function", function: { name: "create_appointment", parameters: {} } }],
  runTool: (...a: unknown[]) => runTool(...(a as [string, Record<string, unknown>])),
}));

const { think } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intent: Intent = { type: "general_question", confidence: 0.3, entities: {} };

function tarefa(type: ConversationTask["type"]): ConversationTask {
  return {
    type,
    state: "offer_options",
    collectedData: { date: "2026-09-07", serviceName: "Avaliação" },
    missingData: [],
    updatedAt: AGORA,
  };
}

async function clienteDiz(texto: string, task: ConversationTask | null) {
  return think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: texto, at: AGORA }],
    contactPhone: "5514996901898",
    contactName: "Rejane",
    customerProfile: null,
    task,
    intent,
  });
}

// Uma resposta com tool_calls faz o loop consumir uma iteração sem texto.
const CHAMA_FERRAMENTA: RespostaFake = {
  content: null,
  tool_calls: [{ id: "t1", function: { name: "find_available_appointments", arguments: '{"date":"2026-09-07"}' } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
  respostas = [];
});

describe("P2 — remarcação move o horário, não cria um segundo", () => {
  it("usa reschedule_appointment quando a tarefa é de remarcação", async () => {
    respostas = [{ content: "Remarquei para 14:00!" }];

    const result = await clienteDiz("as 14h", tarefa("reschedule_appointment"));

    expect(result.rescheduled).toBe(true);
    expect(runTool).toHaveBeenCalledWith("reschedule_appointment", { newStartAt: expect.any(Number) }, expect.anything());
    // O bug: criar um agendamento novo e deixar o antigo ativo.
    expect(runTool).not.toHaveBeenCalledWith("create_appointment", expect.anything(), expect.anything());
    expect(result.booked).toBe(false);
  });

  it("07/09 14:00 local (-03) = 17:00 UTC — mesma conta da listagem", async () => {
    respostas = [{ content: "Remarcado!" }];

    await clienteDiz("as 14h", tarefa("reschedule_appointment"));

    const [, args] = runTool.mock.calls.find((c) => c[0] === "reschedule_appointment")!;
    expect(args.newStartAt).toBe(new Date("2026-09-07T17:00:00.000Z").getTime());
  });

  it("agendamento normal continua usando create_appointment", async () => {
    respostas = [{ content: "Agendado!" }];

    const result = await clienteDiz("as 14h", tarefa("schedule_appointment"));

    expect(result.booked).toBe(true);
    expect(runTool).toHaveBeenCalledWith("create_appointment", expect.anything(), expect.anything());
    expect(runTool).not.toHaveBeenCalledWith("reschedule_appointment", expect.anything(), expect.anything());
  });

  it("se o modelo negar a remarcação já efetivada, a resposta é corrigida", async () => {
    respostas = [{ content: "Não consegui remarcar esse horário." }];

    const result = await clienteDiz("as 14h", tarefa("reschedule_appointment"));

    expect(result.rescheduled).toBe(true);
    expect(result.reply).not.toMatch(/n[ãa]o consegui/i);
    expect(result.reply).toMatch(/remarcado/i);
    expect(result.reply).toMatch(/14:00/);
    expect(result.handoff).toBe(false);
  });
});

describe("P1 — estouro do loop de ferramentas não transfere sozinho", () => {
  it("com horários já consultados, oferece os horários em vez de transferir", async () => {
    // Quatro rodadas seguidas chamando ferramenta: o loop estoura sem texto.
    respostas = [CHAMA_FERRAMENTA, CHAMA_FERRAMENTA, CHAMA_FERRAMENTA, CHAMA_FERRAMENTA];

    const result = await clienteDiz("as 14h", null);

    expect(result.handoff).toBe(false);
    expect(result.reply).toMatch(/14:30/);
    expect(result.reply).toMatch(/15:00/);
    // A frase exata que a cliente recebeu em Production.
    expect(result.reply).not.toMatch(/chamar uma pessoa da equipe/i);
  });

  it("sem nada aproveitável no turno, transferir continua sendo o certo", async () => {
    const semResultado: RespostaFake = {
      content: null,
      tool_calls: [{ id: "t1", function: { name: "get_customer_profile", arguments: "{}" } }],
    };
    respostas = [semResultado, semResultado, semResultado, semResultado];

    const result = await clienteDiz("me ajuda com uma coisa complicada", null);

    expect(result.handoff).toBe(true);
    expect(result.reply).toMatch(/chamar uma pessoa da equipe/i);
  });

  it("com reserva efetivada no turno, confirma a reserva em vez de transferir", async () => {
    const reserva: RespostaFake = {
      content: null,
      tool_calls: [
        { id: "t1", function: { name: "create_appointment", arguments: '{"serviceName":"Avaliação","startAt":1}' } },
      ],
    };
    respostas = [reserva, CHAMA_FERRAMENTA, CHAMA_FERRAMENTA, CHAMA_FERRAMENTA];

    const result = await clienteDiz("as 14h", null);

    expect(result.booked).toBe(true);
    expect(result.handoff).toBe(false);
    expect(result.reply).toMatch(/reservad/i);
    expect(result.reply).toMatch(/14:00/);
  });
});
