// Depois de "Devolver para Lívia", o histórico real inclui as respostas do
// atendente (role "agent"). A Lívia precisa saber que não foram dela.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Establishment, KnowledgeBase, Message } from "@/types";

let lastMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
let scripted = "Combinado!";
vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }) => {
    lastMessages = input.messages;
    return { content: scripted };
  }),
}));
vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: vi.fn(async (establishmentId: string) => ({ establishmentId, utcOffsetMinutes: -180, defaultDurationMin: 30, slotMinutes: 30, days: {} })),
  localToEpoch: vi.fn(), assertBookable: vi.fn(),
}));
vi.mock("@/lib/repo", () => ({ getCustomerProfile: vi.fn(async () => null), upsertCustomerProfile: vi.fn(async () => undefined) }));

const { think } = await import("./brain");

const est = { id: "est", name: "Pizzaria", bot: { personaName: "Lívia", tone: "", bookingEnabled: false, handoffKeywords: [], medicalGuardrail: false } } as unknown as Establishment;
const kb = null as unknown as KnowledgeBase;
const history: Message[] = [
  { id: "1", role: "customer", text: "quero falar com um atendente", at: 1 },
  { id: "2", role: "bot", text: "Claro! Vou chamar uma pessoa da equipe.", at: 2 },
  { id: "3", role: "agent", text: "Oi Ana, troquei sua pizza para calabresa.", at: 3 },
  { id: "4", role: "customer", text: "obrigada! e a bebida?", at: 4 },
];

async function run() {
  return think({ est, kb, history, contactPhone: "5511900000001", contactName: "Ana", customerProfile: null, task: null, intent: { type: "general_question", confidence: 0.5, entities: {} } });
}

beforeEach(() => {
  lastMessages = [];
  scripted = "Combinado!";
});

describe("histórico do atendimento humano para a Lívia", () => {
  it("O: resposta do atendente vai ao modelo marcada como da equipe, com a instrução de continuidade", async () => {
    await run();
    const system = String(lastMessages[0]?.content ?? "");
    expect(system).toContain("ATENDIMENTO HUMANO NESTA CONVERSA");
    const agentTurn = lastMessages.find((m) => typeof m.content === "string" && m.content.includes("calabresa"));
    expect(agentTurn).toMatchObject({ role: "assistant", content: "[Atendente humano da equipe] Oi Ana, troquei sua pizza para calabresa." });
    expect(lastMessages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["quero falar com um atendente", "obrigada! e a bebida?"]);
  });

  it("o marcador nunca aparece na resposta enviada ao cliente", async () => {
    scripted = "[Atendente humano da equipe] A bebida já vai junto!";
    expect((await run()).reply).toBe("A bebida já vai junto!");
  });

  it("sem mensagens de atendente, nenhuma instrução extra entra no prompt", async () => {
    await think({ est, kb, history: [history[0]!], contactPhone: "5511900000001", contactName: "Ana", customerProfile: null, task: null, intent: { type: "general_question", confidence: 0.5, entities: {} } });
    expect(String(lastMessages[0]?.content ?? "")).not.toContain("ATENDIMENTO HUMANO NESTA CONVERSA");
  });
});
