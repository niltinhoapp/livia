// Regressão do teste real de cancelamento (03-04/09/2026).
//
// Cliente: "cancela esse" (logo após a Livia criar o agendamento).
// Livia: "não consigo cancelar agendamentos. Vou transferir você..."
//
// Duas falhas nesta camada: a intenção não era detectada (só o infinitivo
// "cancelar" estava nas keywords) e, sem intenção, nada impedia o modelo de
// inventar uma incapacidade que ele não tem — cancel_appointment está
// registrada e habilitada.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectIntent } from "./intent";
import type { Establishment, Intent } from "@/types";

describe("intenção de cancelar reconhece as formas reais", () => {
  it.each([
    "cancela esse",
    "cancela",
    "cancele meu horário",
    "desmarca esse",
    "desmarcar",
    "quero cancelar",
    "cancela o de segunda",
    "quero cancelar meu agendamento",
    "não vou poder ir",
  ])("'%s' vira cancel_appointment", (texto) => {
    expect(detectIntent(texto).type).toBe("cancel_appointment");
  });

  it("não rouba as intenções vizinhas", () => {
    expect(detectIntent("quero remarcar minha consulta").type).toBe("reschedule_appointment");
    expect(detectIntent("quero agendar uma avaliação").type).toBe("schedule_appointment");
    expect(detectIntent("tenho consulta hoje?").type).toBe("check_appointment");
  });
});

// ---- guarda contra incapacidade inventada ----

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

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [
    { type: "function", function: { name: "cancel_appointment", parameters: {} } },
    { type: "function", function: { name: "get_customer_appointments", parameters: {} } },
  ],
  runTool: async () => ({ ok: true, data: { appointments: [] } }),
}));

const { think, claimsIncapacity } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intent: Intent = { type: "cancel_appointment", confidence: 0.85, entities: {} };

async function responder(texto: string) {
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
});

describe("detecção de incapacidade inventada", () => {
  it("reconhece as formas reais", () => {
    for (const frase of [
      "Entendi, mas não consigo cancelar agendamentos.",
      "Infelizmente não posso cancelar seu horário.",
      "Não tenho como remarcar por aqui.",
    ]) {
      expect(claimsIncapacity(frase), frase).toBe(true);
    }
  });

  it("não confunde com recusa legítima sobre outra coisa", () => {
    expect(claimsIncapacity("Não consigo informar valores de convênio.")).toBe(false);
    expect(claimsIncapacity("Seu agendamento foi cancelado.")).toBe(false);
  });
});

// Contrato ATUAL do fluxo de cancelamento (revisado em 04/09/2026, depois do
// bug real em Production): com intent de cancelamento o backend já resolveu o
// alvo antes de existir qualquer texto, então a resposta é montada a partir do
// CancelOutcome — não há passada corretiva a negociar com o modelo, e não se
// transfere por incapacidade inventada. Transferência aqui só em erro real.
// Ver lib/ai/cancelDeterministic.test.ts para os cenários completos.
describe("a Livia não pode alegar que não sabe cancelar", () => {
  it("a alegação falsa é descartada e a resposta vem do backend", async () => {
    respostas = ["Entendi, mas não consigo cancelar agendamentos. Vou transferir você para um atendente."];

    const result = await responder("cancela esse");

    // Uma única chamada: o desfecho já era conhecido, não há o que corrigir.
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.reply).not.toMatch(/não consigo cancelar/i);
    // O mock devolve zero agendamentos: o certo é dizer isso, não transferir.
    expect(result.reply).toMatch(/não encontrei nenhum agendamento ativo/i);
  });

  it("insistindo na alegação falsa, o cliente ainda assim não lê a mentira", async () => {
    respostas = ["Não consigo cancelar.", "Realmente não consigo cancelar agendamentos."];

    const result = await responder("cancela esse");

    expect(result.reply).not.toMatch(/não consigo cancelar/i);
    expect(result.handoff).toBe(false);
  });

  it("resposta correta de primeira passa intacta", async () => {
    respostas = ["Encontrei seu horário de segunda às 09:00. Confirma o cancelamento?"];

    const result = await responder("cancela esse");

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.reply).toContain("09:00");
  });
});
