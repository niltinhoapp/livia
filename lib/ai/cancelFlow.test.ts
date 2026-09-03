// Fluxo seguro de cancelamento — risco 8 entrando no caminho real.
//
// Cenário do teste real: a Livia acabou de criar 07/09 09:00 Avaliação e o
// cliente escreveu "cancela esse". Antes, cancel_appointment cancelava "o
// próximo agendamento ativo" sem alvo explícito e sem confirmação — com dois
// horários marcados, o errado seria apagado silenciosamente.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTask, Establishment, Intent } from "@/types";

const AGORA = new Date("2026-09-04T17:00:00.000Z").getTime();

let respostas: string[] = [];
const create = vi.fn(async (_p?: unknown) => ({
  choices: [{ message: { content: respostas.shift() ?? "ok", tool_calls: undefined } }],
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: -180, defaultDurationMin: 30, days: {} }),
  localToEpoch: () => 0,
  assertBookable: async () => null,
}));

const SEGUNDA_09H = {
  id: "appt-segunda",
  serviceName: "Avaliação",
  date: "07/09/2026",
  time: "09:00",
  day: "07/09/2026",
  status: "pending",
};
const TERCA_14H = {
  id: "appt-terca",
  serviceName: "Limpeza",
  date: "08/09/2026",
  time: "14:00",
  day: "08/09/2026",
  status: "confirmed",
};

let agenda = [SEGUNDA_09H];
let cancelFalha = false;

const runTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === "get_customer_appointments") return { ok: true, data: { appointments: agenda } };
  if (name === "cancel_appointment") {
    if (cancelFalha) return { ok: false, error: "agendamento não encontrado para este cliente" };
    const alvo = agenda.find((a) => a.id === args.appointmentId);
    if (!alvo) return { ok: false, error: "agendamento não encontrado para este cliente" };
    return { ok: true, data: { cancelled: true, id: alvo.id, serviceName: alvo.serviceName, when: `${alvo.date} às ${alvo.time}` } };
  }
  return { ok: true, data: {} };
});

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [
    { type: "function", function: { name: "cancel_appointment", parameters: {} } },
    { type: "function", function: { name: "get_customer_appointments", parameters: {} } },
  ],
  runTool: (...a: unknown[]) => runTool(...(a as [string, Record<string, unknown>])),
}));

const { think } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intentCancel: Intent = { type: "cancel_appointment", confidence: 0.85, entities: {} };
const intentGeral: Intent = { type: "general_question", confidence: 0.3, entities: {} };

function tarefaAguardandoConfirmacao(appointmentId: string): ConversationTask {
  return {
    type: "cancel_appointment",
    state: "confirm",
    collectedData: { appointmentId },
    missingData: [],
    updatedAt: AGORA,
  };
}

async function conversa(texto: string, intent: Intent, task: ConversationTask | null = null) {
  return think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: texto, at: AGORA }],
    contactPhone: "5514996447132",
    contactName: "Nilton",
    customerProfile: null,
    task,
    intent,
  });
}

function promptDaChamada(i = 0): string {
  return (create.mock.calls[i]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
  respostas = [];
  agenda = [SEGUNDA_09H];
  cancelFalha = false;
});

describe("1. agendamento recém-criado + 'cancela esse'", () => {
  it("identifica exatamente esse agendamento e pede confirmação, sem cancelar", async () => {
    respostas = ["Você quer cancelar a Avaliação de 07/09 às 09:00? Confirma?"];

    const result = await conversa("cancela esse", intentCancel);

    expect(runTool).toHaveBeenCalledWith("get_customer_appointments", {}, expect.anything());
    expect(runTool).not.toHaveBeenCalledWith("cancel_appointment", expect.anything(), expect.anything());
    expect(result.cancelled).toBe(false);
    expect(result.pendingCancelAppointmentId).toBe("appt-segunda");
    expect(promptDaChamada()).toContain("AINDA NÃO FOI CANCELADO");
  });

  it("a confirmação positiva cancela exatamente aquele id", async () => {
    respostas = ["Pronto, cancelei sua Avaliação de 07/09 às 09:00."];

    const result = await conversa("sim, pode cancelar", intentGeral, tarefaAguardandoConfirmacao("appt-segunda"));

    expect(runTool).toHaveBeenCalledWith("cancel_appointment", { appointmentId: "appt-segunda" }, expect.anything());
    expect(result.cancelled).toBe(true);
    expect(promptDaChamada()).toContain("CANCELAMENTO EXECUTADO");
  });
});

describe("2. dois agendamentos ativos + 'cancela esse' sem referência inequívoca", () => {
  beforeEach(() => {
    agenda = [SEGUNDA_09H, TERCA_14H];
  });

  it("NÃO cancela nenhum e pergunta qual", async () => {
    respostas = ["Você tem dois horários. Qual deles quer cancelar?"];

    const result = await conversa("cancela esse", intentCancel);

    expect(runTool).not.toHaveBeenCalledWith("cancel_appointment", expect.anything(), expect.anything());
    expect(result.cancelled).toBe(false);
    expect(result.pendingCancelAppointmentId).toBeNull();

    const prompt = promptDaChamada();
    expect(prompt).toContain("MAIS DE UM agendamento ativo");
    expect(prompt).toContain("NÃO cancele nada");
    // A lista dá dados suficientes para o cliente escolher.
    expect(prompt).toContain("Avaliação");
    expect(prompt).toContain("09:00");
    expect(prompt).toContain("Limpeza");
    expect(prompt).toContain("14:00");
  });
});

describe("3 e 4. resposta negativa não cancela", () => {
  it.each(["não", "nao", "não é isso", "nao e isso", "não, isso não", "deixa pra lá", "não quero cancelar"])(
    "'%s' NÃO cancela",
    async (texto) => {
      respostas = ["Sem problema, seu horário continua marcado."];

      const result = await conversa(texto, intentGeral, tarefaAguardandoConfirmacao("appt-segunda"));

      expect(runTool).not.toHaveBeenCalledWith("cancel_appointment", expect.anything(), expect.anything());
      expect(result.cancelled).toBe(false);
      expect(promptDaChamada()).toContain("NÃO quer cancelar");
    },
  );

  it("resposta ambígua também não cancela — pede confirmação de novo", async () => {
    respostas = ["Só pra confirmar: quer mesmo cancelar a Avaliação de 07/09 às 09:00?"];

    const result = await conversa("acho que sim", intentGeral, tarefaAguardandoConfirmacao("appt-segunda"));

    expect(runTool).not.toHaveBeenCalledWith("cancel_appointment", expect.anything(), expect.anything());
    expect(result.cancelled).toBe(false);
    expect(result.pendingCancelAppointmentId).toBe("appt-segunda");
  });
});

describe("5. confirmação inequívoca cancela só o selecionado", () => {
  beforeEach(() => {
    agenda = [SEGUNDA_09H, TERCA_14H];
  });

  it("cancela o id escolhido e nunca o outro", async () => {
    respostas = ["Cancelado."];

    await conversa("sim", intentGeral, tarefaAguardandoConfirmacao("appt-terca"));

    expect(runTool).toHaveBeenCalledWith("cancel_appointment", { appointmentId: "appt-terca" }, expect.anything());
    expect(runTool).not.toHaveBeenCalledWith("cancel_appointment", { appointmentId: "appt-segunda" }, expect.anything());
  });
});

describe("6. falha do backend", () => {
  it("a Livia NÃO afirma que cancelou", async () => {
    cancelFalha = true;
    respostas = ["Não consegui cancelar agora. Quer que eu chame um atendente?"];

    const result = await conversa("sim, pode cancelar", intentGeral, tarefaAguardandoConfirmacao("appt-segunda"));

    expect(result.cancelled).toBe(false);
    const prompt = promptDaChamada();
    expect(prompt).toContain("FALHOU");
    expect(prompt).toContain("NUNCA diga que cancelou");
  });
});

describe("sem agendamento ativo", () => {
  it("não inventa cancelamento", async () => {
    agenda = [];
    respostas = ["Não encontrei nenhum horário marcado no seu nome."];

    const result = await conversa("cancela esse", intentCancel);

    expect(runTool).not.toHaveBeenCalledWith("cancel_appointment", expect.anything(), expect.anything());
    expect(result.cancelled).toBe(false);
    expect(promptDaChamada()).toContain("NÃO tem nenhum agendamento ativo");
  });
});
