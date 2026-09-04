// Regressão do bug REAL de Production (04/09/2026, deploy 24e63ea).
//
// Condições confirmadas no teste válido: bookingEnabled=true, estabelecimento
// active, conversa devolvida de handoff para bot, intent cancel_appointment.
// Mensagem: "cancela esse". Resposta que chegou ao cliente:
//
//   "Entendi, mas não consigo cancelar agendamentos. Vou transferir você
//    para um atendente que pode ajudar com isso. Um momento, por favor!"
//
// O backend TINHA resolvido o alvo (resolveCancellation) e posto o fato no
// prompt — o modelo simplesmente ignorou a instrução. E o guard de
// incapacidade, ao insistir, marcava handoff mas PRESERVAVA o texto falso.
//
// Estes testes fixam a regra: com intent de cancelamento, a resposta é
// montada pelo backend, não negociada com o modelo.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, Intent } from "@/types";

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

// Agendamentos que o get_customer_appointments devolve neste teste — cada
// cenário troca esta lista antes de chamar think().
let agendamentos: { id: string; serviceName: string; day: string; date: string; time: string }[] = [];
let lookupOk = true;

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [
    { type: "function", function: { name: "cancel_appointment", parameters: {} } },
    { type: "function", function: { name: "get_customer_appointments", parameters: {} } },
  ],
  runTool: async (name: string) => {
    if (name === "get_customer_appointments") {
      return lookupOk
        ? { ok: true, data: { appointments: agendamentos } }
        : { ok: false, error: "falha ao consultar a agenda" };
    }
    return { ok: true, data: {} };
  },
}));

const { think } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const cancelIntent: Intent = { type: "cancel_appointment", confidence: 0.85, entities: {} };

// A resposta falsa exata que chegou ao cliente em Production.
const RESPOSTA_REAL_DO_BUG =
  "Entendi, mas não consigo cancelar agendamentos. Vou transferir você para um atendente que pode ajudar com isso. Um momento, por favor!";

async function responder(texto: string, intent: Intent = cancelIntent) {
  return think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: texto, at: Date.now() }],
    contactPhone: "5514996447132",
    contactName: "Nilton",
    customerProfile: null,
    task: null,
    intent,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  respostas = [];
  agendamentos = [];
  lookupOk = true;
});

describe("A — 1 agendamento ativo: pede confirmação, nunca alega incapacidade", () => {
  beforeEach(() => {
    agendamentos = [{ id: "ap1", serviceName: "Avaliação", day: "amanhã", date: "05/09/2026", time: "09:00" }];
  });

  it("mesmo o modelo insistindo na incapacidade, o cliente recebe o alvo e a pergunta de confirmação", async () => {
    respostas = [RESPOSTA_REAL_DO_BUG, RESPOSTA_REAL_DO_BUG];

    const result = await responder("cancela esse");

    expect(result.reply).not.toMatch(/não consigo cancelar/i);
    expect(result.reply).toContain("Avaliação");
    expect(result.reply).toContain("09:00");
    expect(result.reply).toMatch(/confirma/i);
    expect(result.handoff).toBe(false);
    // Nada foi cancelado ainda: só a confirmação foi pedida.
    expect(result.cancelled).toBe(false);
    expect(result.pendingCancelAppointmentId).toBe("ap1");
  });

  it("resposta boa do modelo continua passando intacta", async () => {
    respostas = ["Encontrei sua Avaliação de amanhã às 09:00. Confirma o cancelamento?"];

    const result = await responder("cancela esse");

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("Encontrei sua Avaliação de amanhã às 09:00. Confirma o cancelamento?");
    expect(result.handoff).toBe(false);
  });
});

describe("B — 0 agendamentos: diz que não encontrou, sem inventar incapacidade", () => {
  it("informa que não há agendamento ativo em vez de alegar que não sabe cancelar", async () => {
    agendamentos = [];
    respostas = [RESPOSTA_REAL_DO_BUG, RESPOSTA_REAL_DO_BUG];

    const result = await responder("cancela esse");

    expect(result.reply).not.toMatch(/não consigo cancelar/i);
    expect(result.reply).toMatch(/não encontrei nenhum agendamento ativo/i);
    expect(result.handoff).toBe(false);
  });
});

describe("C — vários agendamentos: lista e pergunta, sem escolher sozinha", () => {
  it("apresenta as opções e não cancela nada por conta própria", async () => {
    agendamentos = [
      { id: "ap1", serviceName: "Avaliação", day: "amanhã", date: "05/09/2026", time: "09:00" },
      { id: "ap2", serviceName: "Limpeza", day: "sexta", date: "06/09/2026", time: "14:00" },
    ];
    respostas = [RESPOSTA_REAL_DO_BUG, RESPOSTA_REAL_DO_BUG];

    const result = await responder("cancela esse");

    expect(result.reply).not.toMatch(/não consigo cancelar/i);
    expect(result.reply).toContain("Avaliação");
    expect(result.reply).toContain("Limpeza");
    expect(result.reply).toMatch(/qual deles/i);
    expect(result.handoff).toBe(false);
    expect(result.cancelled).toBe(false);
    // Ambíguo não elege alvo: nada fica aguardando confirmação.
    expect(result.pendingCancelAppointmentId).toBeNull();
  });
});

describe("D — o texto falso nunca chega ao cliente", () => {
  it("com intent de cancelamento, a alegação de incapacidade é substituída", async () => {
    agendamentos = [{ id: "ap1", serviceName: "Avaliação", day: "amanhã", date: "05/09/2026", time: "09:00" }];
    respostas = ["não consigo cancelar agendamentos", "realmente não consigo cancelar agendamentos"];

    const result = await responder("cancela esse");

    expect(result.reply).not.toMatch(/não consigo/i);
  });

  it("fora do fluxo de cancelamento, insistir na incapacidade transfere SEM manter o texto falso", async () => {
    // Era o buraco: handoff=true era marcado, mas o reply falso seguia para o
    // cliente. Aqui o intent não é de cancelamento, então quem responde é o
    // guard de incapacidade — e ele também não pode preservar a mentira.
    respostas = ["não consigo remarcar isso", "realmente não posso remarcar isso"];

    const result = await responder("muda meu horário", {
      type: "reschedule_appointment",
      confidence: 0.85,
      entities: {},
    });

    expect(result.handoff).toBe(true);
    expect(result.reply).not.toMatch(/não consigo/i);
  });
});

describe("E — handoff nunca carrega promessa de continuação falsa", () => {
  it("nenhuma espera falsa sobrevive quando a conversa é transferida", async () => {
    respostas = [
      "não consigo remarcar isso. Um momento, por favor!",
      "continuo não podendo remarcar. Vou verificar e já te retorno.",
    ];

    const result = await responder("muda meu horário", {
      type: "reschedule_appointment",
      confidence: 0.85,
      entities: {},
    });

    expect(result.handoff).toBe(true);
    expect(result.reply).not.toMatch(/um momento|vou verificar|aguarde|já te retorno|um instante/i);
  });

  it("cancelamento que falha de verdade transfere, mas sem enrolação", async () => {
    lookupOk = false; // a consulta à agenda falhou: caso real de humano
    respostas = [RESPOSTA_REAL_DO_BUG];

    const result = await responder("cancela esse");

    expect(result.handoff).toBe(true);
    expect(result.reply).not.toMatch(/não consigo cancelar/i);
    expect(result.reply).not.toMatch(/um momento|vou verificar|aguarde/i);
    expect(result.reply).toMatch(/pessoa da equipe/i);
  });
});
