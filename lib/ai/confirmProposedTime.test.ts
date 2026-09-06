// Regressão real de Production (06/09/2026): a Livia oferece um horário
// ("Vou agendar para você às 09:00. Confirma?"), o cliente responde só "ss"
// (sem repetir o horário) e o agendamento falha com "fora do expediente" —
// para um horário que a PRÓPRIA listagem (find_available_appointments) tinha
// acabado de oferecer como livre.
//
// Causa: só o TEXTO das mensagens é persistido entre uma mensagem e outra
// (nunca o JSON da ferramenta com o startAt exato) — ver lib/ai/brain.ts,
// `...history.map(...)`. Sem repetir o horário, resolveTimeSelection() não
// reconhecia a confirmação e o pedido caía na IA, que tinha que "lembrar" e
// recalcular o horário a partir do texto — recálculo que divergia do horário
// real. Corrigido lendo o horário da ÚLTIMA mensagem do BOT quando o cliente
// só confirma (ver extractProposedTime em lib/ai/timeSelection.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTask, Establishment, Intent, Message } from "@/types";

const OFFSET = -180;
const AGORA = new Date("2026-09-06T21:00:00.000Z").getTime();

let respostas: string[] = [];
const create = vi.fn(async (_params?: unknown) => ({
  choices: [{ message: { content: respostas.shift() ?? "ok", tool_calls: undefined } }],
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

const assertBookable = vi.fn(async () => null);

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: OFFSET, defaultDurationMin: 30, days: {} }),
  localToEpoch: (dateStr: string, minutos: number, offset: number) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!) + minutos * 60000 - offset * 60000;
  },
  assertBookable: (...a: unknown[]) => assertBookable(...(a as [])),
}));

const runTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === "create_appointment") {
    return { ok: true, data: { when: "07/09 às 09:00", serviceName: args.serviceName } };
  }
  if (name === "find_available_appointments") {
    return { ok: true, data: { date: args.date, slots: [{ time: "09:00" }, { time: "09:30" }] } };
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

function tarefaAguardandoConfirmacao(): ConversationTask {
  return {
    type: "schedule_appointment",
    state: "confirm",
    collectedData: { date: "2026-09-07", serviceName: "Avaliação" },
    missingData: [],
    updatedAt: AGORA,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
  respostas = [];
});

describe("cliente confirma sem repetir o horário oferecido pela Livia", () => {
  const history: Message[] = [
    { id: "1", role: "bot", text: "Vou agendar para você às 09:00. Você confirma esse horário? 😊", at: AGORA - 1000 },
    { id: "2", role: "customer", text: "ss", at: AGORA },
  ];

  it("reserva o horário que a LIVIA propôs, não um recalculado pela IA", async () => {
    respostas = ["Prontinho! Agendado para 09:00."];

    const result = await think({
      est,
      kb: null,
      history,
      contactPhone: "5514996447132",
      contactName: "Nilton",
      customerProfile: null,
      task: tarefaAguardandoConfirmacao(),
      intent,
    });

    expect(result.booked).toBe(true);
    const [, args] = runTool.mock.calls.find((c) => c[0] === "create_appointment")!;
    // 07/09/2026 09:00 local (-03) = 12:00 UTC — o mesmo instante que
    // find_available_appointments/computeSlots teriam calculado para "09:00".
    expect(args.startAt).toBe(new Date("2026-09-07T12:00:00.000Z").getTime());
  });

  it('também funciona com "sim" e "ok"', async () => {
    for (const confirmacao of ["sim", "ok"]) {
      vi.clearAllMocks();
      respostas = ["Agendado."];
      const h: Message[] = [history[0]!, { id: "2", role: "customer", text: confirmacao, at: AGORA }];
      const result = await think({
        est,
        kb: null,
        history: h,
        contactPhone: "5514996447132",
        contactName: "Nilton",
        customerProfile: null,
        task: tarefaAguardandoConfirmacao(),
        intent,
      });
      expect(result.booked, `"${confirmacao}" deveria confirmar o horário proposto`).toBe(true);
    }
  });

  it("uma negação não reserva nada", async () => {
    respostas = ["Sem problemas!"];
    const h: Message[] = [history[0]!, { id: "2", role: "customer", text: "não, mudei de ideia", at: AGORA }];

    await think({
      est,
      kb: null,
      history: h,
      contactPhone: "5514996447132",
      contactName: "Nilton",
      customerProfile: null,
      task: tarefaAguardandoConfirmacao(),
      intent,
    });

    expect(runTool).not.toHaveBeenCalledWith("create_appointment", expect.anything(), expect.anything());
  });
});
