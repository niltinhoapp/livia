// Regressão real de Production (06/09/2026, cliente Rejane): o agendamento
// das 15:30 FOI criado — ele aparece na agenda — e mesmo assim a resposta
// entregue foi "o horário das 15:30 está muito próximo… que tal 16:00?".
//
// A trava que existia ("desfecho inventado") só reagia a "ocupado" e
// "indisponível" (UNAVAILABLE_CLAIM). Como a recusa foi redigida com outras
// palavras, ela passou batido: horário reservado na agenda, cliente
// convencida de que não tinha horário. A trava nova é ancorada no FATO
// (`booked`, que só é true quando create_appointment retornou ok), nunca no
// vocabulário da recusa.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTask, Establishment, Intent } from "@/types";

const OFFSET = -180;
const AGORA = new Date("2026-09-06T17:00:00.000Z").getTime();

let respostas: string[] = [];
const create = vi.fn(async (_params?: unknown) => ({
  choices: [{ message: { content: respostas.shift() ?? "ok", tool_calls: undefined } }],
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
  if (name === "create_appointment") {
    return { ok: true, data: { when: "07/09 às 15:30", serviceName: args.serviceName } };
  }
  if (name === "find_available_appointments") {
    return { ok: true, data: { date: args.date, slots: [{ time: "15:30" }] } };
  }
  return { ok: true, data: {} };
});

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [{ type: "function", function: { name: "create_appointment", parameters: {} } }],
  runTool: (...a: unknown[]) => runTool(...(a as [string, Record<string, unknown>])),
}));

const { think, deniesBooking, confirmsBooking } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intent: Intent = { type: "general_question", confidence: 0.3, entities: {} };

function tarefa(): ConversationTask {
  return {
    type: "schedule_appointment",
    state: "offer_options",
    collectedData: { date: "2026-09-07", serviceName: "Canal" },
    missingData: [],
    updatedAt: AGORA,
  };
}

async function clienteEscolhe(texto: string) {
  return think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: texto, at: AGORA }],
    contactPhone: "5514996901898",
    contactName: "Rejane",
    customerProfile: null,
    task: tarefa(),
    intent,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
  respostas = [];
});

describe("deniesBooking reconhece as recusas que o backend sabe emitir", () => {
  it.each([
    "o horário das 15:30 está muito próximo. Que tal 16:00?",
    "O horário das 09:00 está fora do expediente.",
    "Esse horário cai no intervalo de almoço.",
    "Não consegui agendar esse horário.",
    "Não foi possível agendar para você.",
    "Esse horário já está ocupado.",
  ])("%s", (texto) => {
    expect(deniesBooking(texto)).toBe(true);
  });

  it("não confunde uma confirmação legítima com recusa", () => {
    expect(deniesBooking("Prontinho! Seu horário de Canal está reservado para 07/09 às 15:30.")).toBe(false);
  });

  // As três recusas reais de Production — cada uma redigida de um jeito.
  it.each([
    "Desculpe, mas o horário das 09:30 está fora do nosso expediente.",
    "O horário das 09:00 não está disponível, pois estamos fechados nesse horário.",
    "Rejane, o horário das 15:30 está muito próximo.",
  ])("não conta como confirmação: %s", (texto) => {
    expect(confirmsBooking(texto)).toBe(false);
  });

  it.each([
    "Prontinho! Seu horário de Avaliação está reservado para 07/09 às 09:30.",
    "Agendado, Niltinho! Te espero dia 07/09 às 09:30.",
    "Sua avaliação está marcada para amanhã às 09:30. 😊",
  ])("conta como confirmação: %s", (texto) => {
    expect(confirmsBooking(texto)).toBe(true);
  });

  it("texto vago, sem afirmar a reserva, não conta como confirmação", () => {
    expect(confirmsBooking("Qual desses horários você prefere? 😊")).toBe(false);
  });
});

describe("reserva criada + texto negando", () => {
  it("a cliente recebe a confirmação real, não a recusa inventada", async () => {
    respostas = ["Rejane, o horário das 15:30 está muito próximo. Que tal 16:00 ou 16:30? 😊"];

    const result = await clienteEscolhe("As 15:30");

    expect(result.booked).toBe(true);
    expect(result.reply).not.toMatch(/muito pr[óo]ximo/i);
    expect(result.reply).toMatch(/15:30/);
    expect(result.reply).toMatch(/reservad/i);
    expect(result.handoff).toBe(false);
  });

  it('também corrige "fora do expediente" para um horário efetivamente reservado', async () => {
    respostas = ["O horário das 15:30 está fora do expediente. Vamos tentar 13:00?"];

    const result = await clienteEscolhe("As 15:30");

    expect(result.booked).toBe(true);
    expect(result.reply).not.toMatch(/fora do expediente/i);
    expect(result.reply).toMatch(/15:30/);
  });

  it('corrige "fora do NOSSO expediente" — o adjetivo no meio escapava do padrão', async () => {
    respostas = ["Desculpe, mas o horário das 15:30 está fora do nosso expediente. Que tal 10:00?"];

    const result = await clienteEscolhe("As 15:30");

    expect(result.booked).toBe(true);
    expect(result.reply).not.toMatch(/fora do nosso expediente/i);
    expect(result.reply).toMatch(/15:30/);
  });

  it("substitui também um texto que apenas ignora a reserva, sem negá-la", async () => {
    respostas = ["Qual desses horários você prefere? 😊"];

    const result = await clienteEscolhe("As 15:30");

    expect(result.booked).toBe(true);
    expect(result.reply).toMatch(/reservad/i);
    expect(result.reply).toMatch(/15:30/);
  });

  it("uma confirmação correta do modelo é preservada como está", async () => {
    respostas = ["Prontinho, Rejane! Canal marcado para 07/09 às 15:30. Até lá! 😊"];

    const result = await clienteEscolhe("As 15:30");

    expect(result.booked).toBe(true);
    expect(result.reply).toMatch(/Prontinho, Rejane/);
  });
});
