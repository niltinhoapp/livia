import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ConversationContext, Establishment, KnowledgeBase, Message } from "@/types";
import { capabilitiesForConversation } from "./conversationPolicy";

let completionInput: { messages: OpenAI.Chat.ChatCompletionMessageParam[]; tools?: OpenAI.Chat.ChatCompletionTool[] } | null = null;

vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: typeof completionInput) => {
    completionInput = input;
    return { content: "Resposta comercial", tool_calls: undefined };
  }),
}));
vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: vi.fn(async (establishmentId: string) => ({ establishmentId, utcOffsetMinutes: -180, defaultDurationMin: 30, slotMinutes: 30, days: {} })),
  localToEpoch: vi.fn(),
  assertBookable: vi.fn(),
}));
vi.mock("@/lib/repo", () => ({ getCustomerProfile: vi.fn(async () => null), upsertCustomerProfile: vi.fn(async () => undefined) }));

const { think } = await import("./brain");

const est = {
  id: "commercial",
  name: "Salão Operacional",
  bot: { personaName: "Lívia", tone: "acolhedora", bookingEnabled: true, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const kb: KnowledgeBase = {
  establishmentId: est.id,
  about: "Salão de beleza",
  address: "Rua Operacional, 10",
  hours: "8h às 18h",
  services: [{ name: "Corte", priceText: "R$ 80", durationText: "40 min", description: null }],
  faqs: [], notes: "", paymentMethods: "Pix", importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0,
};

const ctx = (purpose: "operational" | "commercial" | "audit", extras: Partial<ConversationContext> = {}): ConversationContext => ({
  purpose,
  source: purpose === "audit" ? "audit_calculator" : purpose === "commercial" ? "prospecting" : "normal",
  enteredAt: 100,
  updatedAt: 100,
  ...extras,
});

async function runBrain(context: ConversationContext, text: string, history?: Message[], demoAuthorized = false) {
  const capabilities = capabilitiesForConversation({ context, bookingEnabled: true, ordersEnabled: true, demoAuthorized });
  const result = await think({
    est, kb,
    history: history ?? [{ id: "current", role: "customer", text, at: 100 }],
    contactPhone: "5511999999999", contactName: "Prospect", customerProfile: null, task: null,
    intent: { type: "general_question", confidence: 0.5, entities: {} },
    conversationContext: context, capabilities,
    demoAuthorization: demoAuthorized ? { authorized: true, establishmentId: est.id, prospectingLeadId: "lead" } : { authorized: false },
  });
  const system = completionInput?.messages.find((message) => message.role === "system");
  return { result, prompt: typeof system?.content === "string" ? system.content : "" };
}

async function promptFor(context: ConversationContext, text: string, history?: Message[], demoAuthorized = false): Promise<string> {
  return (await runBrain(context, text, history, demoAuthorized)).prompt;
}

beforeEach(() => { completionInput = null; });

describe("separação Commercial x Operational", () => {
  it("prospect pergunta preço e recebe a fonte da Lívia, sem preço do salão", async () => {
    const { prompt, result } = await runBrain(ctx("commercial"), "Quanto custa?");
    expect(prompt).toMatch(/R\$\s*129/);
    expect(prompt).toContain("7 dias gratuitos");
    expect(prompt).not.toContain("R$ 80");
    expect(prompt).not.toContain("Corte");
    expect(result.reply).toMatch(/R\$\s*129/);
    expect(result.reply).toContain("7 dias gratuitos");
  });

  it("cliente Operational recebe preço do estabelecimento, nunca preço da Lívia", async () => {
    const prompt = await promptFor(ctx("operational"), "Quanto custa?");
    expect(prompt).toContain("Corte");
    expect(prompt).toContain("R$ 80");
    expect(prompt).not.toContain("FONTE COMERCIAL CANÔNICA");
    expect(prompt).not.toMatch(/R\$\s*129/);
  });

  it("Commercial 'tenho clínica' ativa comportamento comercial adaptado", async () => {
    const prompt = await promptFor(ctx("commercial", { commercial: { segment: "clinic", segmentIdentifiedAt: 100 } }), "Tenho uma clínica");
    expect(prompt).toContain("apresentando a própria Lívia");
    expect(prompt).toContain("Segmento identificado: clinic");
    expect(prompt).toContain("agenda, confirmação");
    expect(prompt).toContain("UMA pergunta");
  });

  it("Operational 'tenho clínica' não vira venda da Lívia", async () => {
    const prompt = await promptFor(ctx("operational"), "Tenho uma clínica");
    expect(prompt).toContain("NÃO transforme atendimento operacional em venda");
    expect(prompt).not.toContain("FONTE COMERCIAL CANÔNICA");
  });
});

describe("cérebro Audit", () => {
  const auditContext = ctx("audit", {
    commercial: { segment: "restaurant", segmentIdentifiedAt: 100 },
    audit: { leadsPerDay: 20, averageTicketCents: 15_000, responseTimeText: "2 horas", estimatedOpportunityCentsPerMonth: 1_200_000, capturedAt: 100 },
  });

  it("explica o diagnóstico primeiro e não repete dados já recebidos", async () => {
    const prompt = await promptFor(auditContext, "Acabei de fazer a Auditoria");
    expect(prompt).toContain("comece pelo resultado/diagnóstico recebido");
    expect(prompt).toContain("Leads por dia informados: 20");
    expect(prompt).toMatch(/Ticket médio informado: R\$\s*150/);
    expect(prompt).toContain("Tempo médio de resposta informado: 2 horas");
    expect(prompt).toContain("NÃO pergunte por eles novamente");
  });

  it("trata estimativa como simulação, sem promessa de recuperação", async () => {
    const prompt = await promptFor(auditContext, "Explique a estimativa");
    expect(prompt).toContain("simulação de potencial");
    expect(prompt).toContain("Não é perda comprovada");
    expect(prompt).toContain("não garante recuperação do valor");
    expect(prompt).toContain("Nunca prometa recuperar receita");
  });

  it("no segundo/terceiro turno mantém os fatos sem reiniciar diagnóstico", async () => {
    const history: Message[] = [
      { id: "a", role: "customer", text: "Auditoria", at: 100 },
      { id: "b", role: "bot", text: "Essa é uma estimativa de potencial.", at: 110 },
      { id: "c", role: "customer", text: "Tenho um restaurante", at: 200 },
      { id: "d", role: "bot", text: "Posso mostrar atendimento e pedidos.", at: 210 },
      { id: "e", role: "customer", text: "Como ajudaria?", at: 300 },
    ];
    const prompt = await promptFor(auditContext, "Como ajudaria?", history);
    expect(prompt).toContain("Leads por dia informados: 20");
    expect(prompt).not.toContain("NA RESPOSTA ATUAL, comece");
  });
});

describe("segmentação, demo e CTA", () => {
  it.each([
    ["salon", "horários e agenda"],
    ["restaurant", "cardápio"],
    ["pet", "dúvidas sobre serviços"],
    ["optical", "dúvidas frequentes"],
  ] as const)("adapta %s sem inventar funcionalidade", async (segment, expected) => {
    const prompt = await promptFor(ctx("commercial", { commercial: { segment, segmentIdentifiedAt: 100 } }), `Tenho ${segment}`);
    expect(prompt).toContain(expected);
    expect(prompt).toContain("Não invente recurso");
  });

  it("sem demo autorizada só oferece próximo passo; não executa nem contrata ficticiamente", async () => {
    const prompt = await promptFor(ctx("commercial", { commercial: { segment: "restaurant", segmentIdentifiedAt: 100 } }), "Pode demonstrar?");
    expect(prompt).toContain("demo_execution NÃO está autorizada");
    expect(prompt).toContain("Nunca diga que teste, conta ou contratação foi ativado");
  });

  it("com demo autorizada encaminha somente pelas interfaces disponíveis", async () => {
    const prompt = await promptFor(ctx("commercial", { commercial: { segment: "clinic", segmentIdentifiedAt: 100 } }), "Pode demonstrar agenda?", undefined, true);
    expect(prompt).toContain("demo_execution está autorizada");
    expect(prompt).toContain("DADOS DO AMBIENTE DE DEMONSTRAÇÃO");
  });
});
