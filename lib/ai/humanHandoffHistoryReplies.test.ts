// Depois de "Devolver para Lívia": o histórico do atendimento humano está no
// contexto. Regressões dos dois casos reais do teste pós-#184.
//
// Integração real: think() + tools + lib/scheduling sobre o Firestore fake;
// só o modelo de linguagem é roteirizado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Establishment, KnowledgeBase, Message } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

type ModelMessage = { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
let script: ModelMessage[] = [];
const calls: OpenAI.Chat.ChatCompletionMessageParam[][] = [];
vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }) => {
    calls.push([...input.messages]);
    return script.shift() ?? { content: "Pode me contar?" };
  }),
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { claimsHistoryBlindness, think } from "./brain";
import { detectIntent } from "./intent";

const EST = "clinica-real";
const PHONE = "5511955550002";
const NOW = new Date("2026-10-06T13:00:00.000Z");

const est = {
  id: EST, name: "Clínica Sorriso", type: "odonto", ownerUid: EST, status: "active", createdAt: 0,
  bot: { personaName: "Lívia", tone: "acolhedora", bookingEnabled: true, ordersEnabled: false, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const kb: KnowledgeBase = {
  establishmentId: EST, about: "Clínica odontológica", address: "Rua A, 1", hours: "Seg a sex, 8h às 18h",
  services: [{ name: "Avaliação", priceText: "R$ 120", durationText: "40 min", description: null }],
  faqs: [], notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0,
};

const at = (min: number) => NOW.getTime() - (60 - min) * 60_000;
const customer = (text: string, t: number): Message => ({ id: `c${t}`, role: "customer", text, at: t });
const agent = (text: string, t: number): Message => ({ id: `a${t}`, role: "agent", text, at: t });
const corrections = () => calls.flatMap((c) => c.slice(1).filter((m) => m.role === "system").map((m) => String(m.content)));

async function run(history: Message[]) {
  const last = history.at(-1)!.text;
  return think({
    est, kb, history, contactPhone: PHONE, contactName: "Carlos", customerProfile: null, task: null,
    intent: detectIntent(last),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fakeDb.reset();
  fakeDb.col("establishments").set(EST, { id: EST, bot: est.bot });
  script = [];
  calls.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("Lívia depois de devolvida: histórico humano é lido, não negado", () => {
  it("caso Carlos: 'vou verificar' do atendente não vira agendamento; a agenda real é consultada e nada é criado", async () => {
    const history = [
      customer("Meu nome é Carlos e quero atendimento amanhã às 15 horas.", at(1)),
      agent("Certo, Carlos. Vou verificar o horário das 15 horas para você.", at(2)),
      customer("Qual foi o horário que combinei com o atendente?", at(30)),
    ];
    const reply = "Pelo que consta aqui, não há agendamento ativo registrado. O atendente informou que iria verificar amanhã às 15h, mas não confirmou a reserva.";
    // Como no teste real: a Lívia consulta a agenda de verdade antes de responder.
    script = [
      { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "get_customer_appointments", arguments: "{}" } }] },
      { content: reply },
    ];

    const result = await run(history);

    expect(result).toMatchObject({ reply, handoff: false, booked: false });
    expect(result.toolCalls.map((c) => c.name)).toContain("get_customer_appointments");
    expect(result.toolCalls.map((c) => c.name)).not.toContain("create_appointment");
    expect(fakeDb.col(`establishments/${EST}/appointments`).size).toBe(0);
    expect(corrections()).toEqual([]);
    const sent = calls[0]!;
    expect(String(sent[0]!.content)).toContain("ATENDIMENTO HUMANO NESTA CONVERSA");
    expect(sent.find((m) => String(m.content).includes("Vou verificar"))).toMatchObject({ role: "assistant", content: "[Atendente humano da equipe] Certo, Carlos. Vou verificar o horário das 15 horas para você." });
  });

  it("caso da dúvida anunciada: 'não consigo ver o conteúdo' é corrigido para o que o cliente de fato escreveu", async () => {
    const history = [
      customer("Tenho mais uma dúvida.", at(1)),
      customer("E aquela dúvida que eu falei enquanto estava com o atendente?", at(30)),
    ];
    script = [
      { content: "Claro! Pode me dizer qual é a dúvida? Não consigo ver o conteúdo dela aqui." },
      { content: "Você comentou que tinha mais uma dúvida, mas não chegou a dizer qual era. Pode me contar?" },
    ];

    const result = await run(history);

    expect(result).toMatchObject({ reply: "Você comentou que tinha mais uma dúvida, mas não chegou a dizer qual era. Pode me contar?", handoff: false });
    expect(corrections()).toEqual([expect.stringContaining("não consegue ver mensagens ou o histórico")]);
    expect(String(calls[0]![0]!.content)).toContain("Nunca diga que não consegue ver mensagens anteriores");
    expect(calls[0]!.map((m) => m.content)).toContain("Tenho mais uma dúvida.");
  });

  it("se o modelo insistir, só a frase falsa sai — a pergunta ao cliente fica, nada é inventado", async () => {
    const history = [customer("Tenho mais uma dúvida.", at(1)), customer("E aquela dúvida que eu falei enquanto estava com o atendente?", at(30))];
    script = [
      { content: "Claro! Pode me dizer qual é a dúvida? Não consigo ver o conteúdo dela aqui." },
      { content: "Pode me dizer qual é a dúvida? Não tenho acesso ao histórico." },
    ];
    const result = await run(history);
    expect(result).toMatchObject({ reply: "Pode me dizer qual é a dúvida?", handoff: false });
  });
});

describe("claimsHistoryBlindness", () => {
  it.each([
    "Não consigo ver o conteúdo dela aqui.",
    "Não tenho acesso ao histórico da conversa.",
    "Infelizmente não consigo visualizar as mensagens anteriores.",
    "Não posso ver o que você disse para o atendente.",
    "não consegui ler a mensagem anterior",
  ])("reconhece: %s", (text) => {
    expect(claimsHistoryBlindness(text)).toBe(true);
  });

  it.each([
    "Você comentou que tinha mais uma dúvida, mas não chegou a dizer qual era.",
    "Pelo que consta aqui, não há agendamento ativo registrado.",
    "Não consegui encontrar agendamento no seu nome.",
    "Não consigo ver horários livres para amanhã, quer outro dia?",
    "Não consigo agendar nesse horário.",
  ])("não confunde resultado real de consulta com cegueira de histórico: %s", (text) => {
    expect(claimsHistoryBlindness(text)).toBe(false);
  });
});
