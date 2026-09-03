// Regressão do BUG 3 do teste real de 03/09/2026.
//
// Cliente informou "Nilton" (faltava ainda o DIA) e a Livia respondeu:
// "Obrigada, Nilton! Vou verificar a disponibilidade para a avaliação. Um
// momento, por favor." — uma promessa de continuação que nunca aconteceria:
// a execução termina quando a resposta é enviada, nada roda depois.
//
// A trava anti-enrolação existia, mas só no fluxo de check_appointment
// (quando havia consulta de agenda). Aqui ela vira regra geral de
// orquestração: detecta a enrolação em QUALQUER turno, dá uma segunda passada
// com correção explícita e, se persistir, transfere de verdade.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, Intent } from "@/types";

// Respostas encadeadas do modelo, uma por chamada.
let respostas: string[] = [];
const create = vi.fn(async (_params?: unknown) => ({
  choices: [{ message: { content: respostas.shift() ?? "", tool_calls: undefined } }],
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
  toolsFor: () => [{ type: "function", function: { name: "find_available_appointments", parameters: {} } }],
  runTool: async () => ({ ok: true, data: {} }),
}));

const { think, looksLikeStalling } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intent: Intent = { type: "general_question", confidence: 0.3, entities: {} };

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

describe("detecção de enrolação", () => {
  it("reconhece as formas reais de promessa vazia", () => {
    for (const frase of [
      "Vou verificar a disponibilidade para a avaliação. Um momento, por favor.",
      "Deixa eu conferir aqui",
      "Já te retorno",
      "Aguarde um instante",
      "Vou consultar a agenda e te aviso",
    ]) {
      expect(looksLikeStalling(frase), frase).toBe(true);
    }
  });

  it("não confunde com texto legítimo que descreve status", () => {
    for (const frase of [
      "Seu horário está reservado, aguardando sua confirmação.",
      "Em qual dia você gostaria de agendar?",
      "Confirmado para amanhã às 14:30.",
    ]) {
      expect(looksLikeStalling(frase), frase).toBe(false);
    }
  });
});

describe("regra geral: nenhuma promessa de continuação sobrevive", () => {
  it("cenário real: o modelo enrola e, na correção, pede o dia que faltava", async () => {
    respostas = [
      "Obrigada, Nilton! Vou verificar a disponibilidade para a avaliação. Um momento, por favor.",
      "Obrigada, Nilton! Para qual dia você gostaria de agendar a avaliação?",
    ];

    const result = await responder("Nilton");

    // Houve uma segunda passada corrigindo a resposta.
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.reply).not.toMatch(/vou verificar|um momento|aguarde|já te retorno/i);
    // E ela pede exatamente o que faltava.
    expect(result.reply).toMatch(/dia/i);
    // Não precisou de humano: a conversa podia continuar sozinha.
    expect(result.handoff).toBe(false);
  });

  it("a correção enviada ao modelo explica que não existe continuação", async () => {
    respostas = ["Vou verificar e já te retorno.", "Para qual dia?"];

    await responder("Nilton");

    const segundaChamada = create.mock.calls[1]?.[0] as unknown as {
      messages: { role: string; content: string }[];
    };
    const correcao = segundaChamada.messages.at(-1)!;
    expect(correcao.role).toBe("system");
    expect(correcao.content).toMatch(/execução termina agora/i);
    expect(correcao.content).toMatch(/PEÇA essa informação/i);
  });

  it("se o modelo insistir em enrolar, transfere para humano em vez de deixar esperando", async () => {
    respostas = ["Um momento, por favor.", "Vou verificar e já te retorno."];

    const result = await responder("Nilton");

    expect(result.handoff).toBe(true);
    expect(result.reply).not.toMatch(/vou verificar|um momento|aguarde|já te retorno/i);
  });

  it("só corrige uma vez por turno (não entra em laço com modelo teimoso)", async () => {
    respostas = ["Um momento.", "Aguarde.", "Aguarde.", "Aguarde."];

    await responder("Nilton");

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("resposta boa de primeira passa intacta, sem chamada extra", async () => {
    respostas = ["Claro, Nilton! Para qual dia você quer agendar?"];

    const result = await responder("Nilton");

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("Claro, Nilton! Para qual dia você quer agendar?");
    expect(result.handoff).toBe(false);
  });
});
