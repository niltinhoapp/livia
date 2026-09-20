// F3 da Lívia Alimentação V2 — as regras de conversa de pedido que passaram
// a entrar no prompt. Mesmo padrão de lib/ai/knowledgeToolExposure.test.ts:
// o gateway é interceptado só para ler o prompt montado.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Establishment, Intent, KnowledgeBase } from "@/types";

let completionInput: { messages: OpenAI.Chat.ChatCompletionMessageParam[] } | null = null;

vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: typeof completionInput) => {
    completionInput = input;
    return { content: "Claro! O que você vai querer?", tool_calls: undefined };
  }),
}));
vi.mock("@/lib/repo", () => ({
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(async () => undefined),
}));
// brain importa lib/scheduling, que abre o Firebase Admin no import. Só o
// prompt interessa aqui, então o módulo é substituído inteiro — mesmo
// tratamento de lib/ai/knowledgeToolExposure.test.ts.
vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: vi.fn(async (establishmentId: string) => ({ establishmentId, utcOffsetMinutes: -180, defaultDurationMin: 30, slotMinutes: 30, days: {} })),
  localToEpoch: vi.fn(),
  assertBookable: vi.fn(),
}));

const { think } = await import("./brain");

const est = (ordersEnabled: boolean): Establishment => ({
  id: "est-1", name: "Lanchonete Exemplo", type: "lanchonete", ownerUid: "u1", status: "active", createdAt: 0,
  bot: { personaName: "Lívia", tone: "acolhedora", bookingEnabled: false, ordersEnabled, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment);

const kb: KnowledgeBase = {
  establishmentId: "est-1", about: "Lanchonete", address: null, hours: null, services: [], faqs: [],
  notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null,
  handoffTriggers: null, updatedAt: 0,
};
const intent: Intent = { type: "general_question", confidence: 0.6, entities: {} };

async function systemPrompt(ordersEnabled = true): Promise<string> {
  await think({
    est: est(ordersEnabled), kb, history: [{ id: "m1", role: "customer", text: "oi", at: Date.now() }],
    contactPhone: "5514991234567", contactName: "Cliente", customerProfile: null, task: null, intent,
  });
  const system = completionInput?.messages.find((m) => m.role === "system");
  return String(system?.content ?? "");
}

beforeEach(() => {
  completionInput = null;
  vi.clearAllMocks();
});

describe("regras de pedido no prompt", () => {
  it("manda usar list_menu quando o cliente pede o cardápio sem citar item", async () => {
    expect(await systemPrompt()).toMatch(/list_menu/);
  });

  it("proíbe escolher por conta própria entre itens parecidos", async () => {
    expect(await systemPrompt()).toMatch(/PERGUNTE qual antes de adicionar/i);
  });

  it("manda conferir quantidade quando o resumo marca item repetido", async () => {
    expect(await systemPrompt()).toMatch(/repeatedProduct/);
  });

  it("repassa PIX como instrução e proíbe confirmar pagamento sozinha", async () => {
    const prompt = await systemPrompt();
    expect(prompt).toMatch(/pixInstructions/);
    expect(prompt).toMatch(/NUNCA confirma pagamento/i);
    expect(prompt).toMatch(/comprovante/i);
  });

  it("orienta o tom de atendente de balcão", async () => {
    expect(await systemPrompt()).toMatch(/atendente de balcão/i);
  });

  it("estabelecimento sem pedidos não recebe nenhuma dessas regras", async () => {
    const prompt = await systemPrompt(false);
    expect(prompt).not.toMatch(/list_menu/);
    expect(prompt).not.toMatch(/pixInstructions/);
  });
});
