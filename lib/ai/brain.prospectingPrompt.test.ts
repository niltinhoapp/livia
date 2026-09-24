import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Establishment, Intent, ProspectingContext } from "@/types";

let completionInput: { messages: OpenAI.Chat.ChatCompletionMessageParam[] } | null = null;

vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: typeof completionInput) => {
    completionInput = input;
    return { content: "Certo!", tool_calls: undefined };
  }),
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: vi.fn(async (establishmentId: string) => ({
    establishmentId, utcOffsetMinutes: -180, defaultDurationMin: 30, slotMinutes: 30, days: {},
  })),
  localToEpoch: vi.fn(),
  assertBookable: vi.fn(),
}));

vi.mock("@/lib/repo", () => ({
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(async () => undefined),
}));

const { think } = await import("./brain");

const intent: Intent = { type: "general_question", confidence: 0.4, entities: {} };

function est(overrides: Partial<Establishment["bot"]> = {}): Establishment {
  return {
    id: "conectweb", name: "ConectWeb", type: "servicos", ownerUid: "owner", status: "active", createdAt: 0,
    bot: {
      personaName: "Lívia", tone: "acolhedora", bookingEnabled: true, ordersEnabled: false,
      handoffKeywords: [], medicalGuardrail: false, ...overrides,
    },
  } as unknown as Establishment;
}

function context(status: ProspectingContext["status"], over: Partial<ProspectingContext> = {}): ProspectingContext {
  return {
    leadId: "lead-rafael", normalizedPhone: "5514996074995", businessName: "Barbearia Rafael", segment: "barbearia",
    initialManualMessage: "Vocês fazem agendamento?", status, preRevealReplyCount: 0,
    preparedAt: 1, manualSendConfirmedAt: 2, firstReplyAt: 3, revealedAt: null, expiresAt: 4,
    ...over,
  };
}

async function promptFor(prospectingContext?: ProspectingContext, business = est()): Promise<string> {
  completionInput = null;
  await think({
    est: business,
    kb: null,
    history: [{ id: "m1", role: "customer", text: "Aqui só corte masculino", at: Date.now() }],
    contactPhone: "5514996074995", contactName: "Rafael", customerProfile: null, task: null, intent, prospectingContext,
  });
  const captured = completionInput as { messages: OpenAI.Chat.ChatCompletionMessageParam[] } | null;
  const system = captured?.messages.find((message) => message.role === "system");
  return String(system?.content ?? "");
}

beforeEach(() => {
  completionInput = null;
  vi.clearAllMocks();
});

describe("prospecção comercial no prompt", () => {
  it("faz da revelação para a barbearia uma primeira apresentação comercial contextual", async () => {
    const prompt = await promptFor(context("LIVIA_ACTIVE"));

    expect(prompt).toContain('"Barbearia Rafael"');
    expect(prompt).toContain('"barbearia"');
    expect(prompt).toContain("A resposta desta revelação TAMBÉM é a primeira apresentação comercial");
    expect(prompt).toMatch(/conversa anterior foi uma demonstração prática/i);
    expect(prompt).toMatch(/UMA situação plausível como hipótese/i);
    expect(prompt).toMatch(/UMA pergunta curta/i);
    expect(prompt).toMatch(/Nunca afirme que eles demoram para responder, perdem clientes, estão sobrecarregados/i);
    expect(prompt).toMatch(/agendamentos quando essa função estiver configurada/i);
    expect(completionInput?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Aqui só corte masculino" }),
    ]));
  });

  it("adapta o contexto para outro segmento sem regra fixa de barbearia", async () => {
    const prompt = await promptFor(context("LIVIA_ACTIVE", {
      businessName: "Clínica Sorriso", segment: "clínica odontológica", initialManualMessage: "Gostaria de uma avaliação",
    }));

    expect(prompt).toContain('"Clínica Sorriso"');
    expect(prompt).toContain('"clínica odontológica"');
    expect(prompt).not.toContain('"Barbearia Rafael"');
    expect(prompt).toMatch(/não use roteiro fixo por segmento/i);
  });

  it("apresenta recursos opcionais somente quando estão disponíveis", async () => {
    const prompt = await promptFor(
      context("LIVIA_ACTIVE", { businessName: "Restaurante Sabor", segment: "restaurante" }),
      est({ bookingEnabled: false, ordersEnabled: true }),
    );

    expect(prompt).toMatch(/ajudar com pedidos quando essa função estiver configurada/i);
    expect(prompt).not.toMatch(/ajudar com agendamentos quando essa função estiver configurada/i);
  });

  it.each(["REVEALED", "INTERESTED"] as const)("continua a venda após %s sem repetir a apresentação", async (status) => {
    const prompt = await promptFor(context(status));

    expect(prompt).toMatch(/Não repita a apresentação inteira/i);
    expect(prompt).toMatch(/descubra como o estabelecimento atende hoje ou qual necessidade quer resolver/i);
    expect(prompt).toMatch(/UMA pergunta por vez/i);
    expect(prompt).toMatch(/negociação de preço, desconto, condição especial, contratação\/fechamento/i);
  });

  it("não adiciona regras comerciais fora de prospectingContext", async () => {
    const prompt = await promptFor();

    expect(prompt).not.toContain("MODO PROSPECÇÃO COMERCIAL");
    expect(prompt).not.toContain("primeira apresentação comercial");
    expect(prompt).not.toContain("Barbearia Rafael");
  });

  it("preserva as travas pré-revelação", async () => {
    const prompt = await promptFor(context("LIVIA_ACTIVE", { preRevealReplyCount: 1 }));

    expect(prompt).toMatch(/limite máximo de interações pré-revelação \(1\)/i);
    expect(prompt).toMatch(/NÃO PODE MAIS SIMULAR NADA/i);
    expect(prompt).toMatch(/NUNCA invente nome falso, não invente dados pessoais, não marque nada/i);
    expect(prompt).toMatch(/SÓ muda de assunto para a venda\/prospecção APÓS usar a ferramenta update_prospecting_status/i);
  });
});
