// Requisito 7 da correção de 03/09: a Livia não pode prometer que vai
// verificar depois e encerrar a execução. A execução termina quando ela
// responde — nada continua. Se não deu para resolver na mesma execução, o
// caminho correto é transferir para uma pessoa (handoff), não pedir para o
// cliente aguardar.
//
// Cenário coberto: o loop de ferramentas estoura (o modelo fica pedindo
// ferramenta e nunca escreve a resposta final). Antes, esse caminho devolvia
// "Deixa eu confirmar isso com a equipe e já te retorno" com handoff: false —
// ninguém era acionado e o cliente ficava esperando para sempre.
import { describe, expect, it, vi } from "vitest";
import type { Establishment, Intent } from "@/types";

// O modelo sempre pede ferramenta e nunca escreve texto final -> força o
// loop a estourar as 4 iterações.
const create = vi.fn(async () => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [{ id: "call_1", function: { name: "get_customer_appointments", arguments: "{}" } }],
      },
    },
  ],
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: -180, defaultDurationMin: 30, days: {} }),
}));

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [{ type: "function", function: { name: "get_customer_appointments", parameters: {} } }],
  runTool: async () => ({ ok: true, data: { appointments: [] } }),
}));

const { think } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intent: Intent = { type: "general_question", confidence: 0.3, entities: {} };

describe("nunca prometer verificação sem continuação real", () => {
  it("quando o loop de ferramentas estoura, transfere para humano em vez de pedir para aguardar", async () => {
    const result = await think({
      est,
      kb: null,
      history: [{ id: "1", role: "customer", text: "Confirma minha consulta", at: Date.now() }],
      contactPhone: "5514996447132",
      contactName: "Cliente",
      customerProfile: null,
      task: null,
      intent,
    });

    // O handoff é o que garante continuação real: o webhook muda a conversa
    // para "handoff" e uma pessoa assume.
    expect(result.handoff).toBe(true);

    // E a resposta não pode conter uma promessa de retornar depois.
    expect(result.reply).not.toMatch(/já te retorno|vou verificar|verifico e|um momento|aguarde|aguardando/i);
  });

  it("nenhuma operação é reportada como concluída quando nada foi executado", async () => {
    const result = await think({
      est,
      kb: null,
      history: [{ id: "1", role: "customer", text: "Confirma minha consulta", at: Date.now() }],
      contactPhone: "5514996447132",
      contactName: "Cliente",
      customerProfile: null,
      task: null,
      intent,
    });

    expect(result.booked).toBe(false);
    expect(result.rescheduled).toBe(false);
    expect(result.cancelled).toBe(false);
  });
});
