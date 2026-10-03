// F7 — a demonstração É o argumento de venda.
//
// Caso de Production (03/10/2026), canal demo: o prospect aceitou três vezes
// ("Ss", "Continue", "Legal") e recebeu três paráfrases de "a Lívia consulta
// o cardápio e ajuda a montar o pedido" — nenhuma tool executada. Trocou a
// prova pela promessa. commercialContext.ts já mandava executar; nada
// verificava se foi obedecido.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ConversationContext, Establishment, Intent, KnowledgeBase } from "@/types";

// Respostas encadeadas do modelo, uma por chamada do gateway.
let respostas: { content: string; tool_calls?: unknown }[] = [];
const calls: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }[] = [];
vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }) => {
    calls.push(input);
    return respostas.shift() ?? { content: "", tool_calls: undefined };
  }),
}));
vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: -180, defaultDurationMin: 30, days: {} }),
  localToEpoch: () => 0,
  assertBookable: async () => null,
}));
vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [{ type: "function", function: { name: "list_menu", description: "Cardápio", parameters: {} } }],
  runTool: async () => ({ ok: true, data: {} }),
}));

const { describesInsteadOfDemonstrating, think } = await import("./brain");
const { capabilitiesForConversation } = await import("./conversationPolicy");

describe("describesInsteadOfDemonstrating", () => {
  // As frases exatas que chegaram ao prospect.
  it.each([
    "No delivery, a Lívia pode consultar o cardápio e ajudar a montar pedidos pelo WhatsApp, desde que a operação esteja configurada.",
    "Funciona assim: com o cardápio configurado, a Lívia consulta os itens disponíveis e ajuda o cliente a montar o pedido.",
    "Não é um teste real aqui, só uma explicação de como funcionaria.",
    "Depois que o cliente escolhe os itens, a Lívia ajuda a organizar o pedido com base no cardápio configurado.",
    "Nela, a Lívia pode responder pelo WhatsApp às dúvidas mais comuns dos clientes.",
  ])("detecta descrição no lugar da demonstração: %s", (reply) => {
    expect(describesInsteadOfDemonstrating(reply)).toBe(true);
  });

  // Resposta que EXECUTOU: fala do resultado, não da capacidade.
  it.each([
    "Adicionei 1 X-Burger (R$ 28,00) ao pedido. Quer bebida?",
    "Tenho estes horários amanhã: 10h, 14h e 16h. Qual fica melhor?",
    "Seu pedido ficou assim: 1 X-Burger e 1 Coca. Confirma?",
    "Agendei para quinta às 15h. Te espero lá!",
    "O X-Salada custa R$ 32,00.",
  ])("não dispara quando a resposta traz resultado real: %s", (reply) => {
    expect(describesInsteadOfDemonstrating(reply)).toBe(false);
  });

  it("não confunde primeira pessoa com descrição de produto", () => {
    expect(describesInsteadOfDemonstrating("Consultei o cardápio e separei as opções.")).toBe(false);
    expect(describesInsteadOfDemonstrating("Posso te mostrar agora mesmo.")).toBe(false);
  });

  it("não dispara em apresentação legítima", () => {
    expect(describesInsteadOfDemonstrating("Oi! Sou a Lívia, da ConectWeb.")).toBe(false);
  });
});

// ---- A trava dentro do think() ----

const est = {
  id: "demo-channel",
  name: "Lanchonete",
  demoChannel: { enabled: true },
  bot: { personaName: "Lívia", tone: "objetiva", bookingEnabled: true, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const kb = null as unknown as KnowledgeBase | null;
const intent: Intent = { type: "general_question", confidence: 1, entities: {} };
const context: ConversationContext = {
  purpose: "commercial", source: "prospecting", enteredAt: 100, updatedAt: 100,
  commercial: { segment: "restaurant", segmentIdentifiedAt: 100 },
};

const DESCREVE = "No delivery, a Lívia pode consultar o cardápio e ajudar a montar pedidos pelo WhatsApp.";
const EXECUTA = "Separei do cardápio: X-Burger R$ 28,00 e Coca R$ 6,00. Qual você quer?";

async function conversa(clienteDisse: string, autorizada: boolean, ofertaDaLivia = "Quer ver funcionando aqui mesmo?") {
  const demoAuthorization = autorizada
    ? { authorized: true as const, establishmentId: est.id, prospectingLeadId: "lead-1" }
    : { authorized: false as const };
  return think({
    est, kb,
    history: [
      { id: "oferta", role: "bot", text: ofertaDaLivia, at: 200 },
      { id: "aceite", role: "customer", text: clienteDisse, at: 300 },
    ],
    contactPhone: "5511900000001", contactName: "Prospect", customerProfile: null, task: null,
    intent, demoAuthorization, conversationContext: context,
    prospectingContext: { status: "INTERESTED", leadId: "lead-1", segment: "lanchonete" } as never,
    capabilities: capabilitiesForConversation({
      context, bookingEnabled: true, ordersEnabled: true, demoAuthorized: demoAuthorization.authorized,
    }),
  });
}

beforeEach(() => {
  respostas = [];
  calls.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("trava: descreveu quando devia ter demonstrado", () => {
  it("com demo autorizada e aceite do prospect, força uma passada corretiva", async () => {
    respostas = [{ content: DESCREVE }, { content: EXECUTA }];

    const result = await conversa("Quero", true);

    expect(calls).toHaveLength(2);
    const correcao = calls[1]!.messages.at(-1);
    expect(correcao?.role).toBe("system");
    expect(String(correcao?.content)).toContain("DESCREVEU o que a Lívia faz");
    expect(String(correcao?.content)).toContain("list_menu");
    // O prospect recebe o resultado real, não a descrição.
    expect(result.reply).toBe(EXECUTA);
  });

  // O contrário do bug: sem autorização, descrever é o comportamento CORRETO
  // (ramo "demo_execution NÃO está autorizada" de commercialContext.ts).
  // Corrigir aqui mandaria a Lívia executar o que ela está proibida de fazer.
  it("sem demo autorizada, não corrige — descrever é o certo", async () => {
    respostas = [{ content: DESCREVE }];

    const result = await conversa("Quero", false);

    expect(calls).toHaveLength(1);
    expect(result.reply).toBe(DESCREVE);
  });

  // Sem aceite, a descrição é resposta legítima a uma pergunta aberta.
  it("sem aceite do prospect, não corrige", async () => {
    respostas = [{ content: DESCREVE }];

    const result = await conversa("E no delivery?", true, "Como posso ajudar?");

    expect(calls).toHaveLength(1);
    expect(result.reply).toBe(DESCREVE);
  });

  // Insistiu: a resposta passa como está. Não dá para fabricar demonstração
  // reescrevendo texto, e transferir puniria o prospect por redação.
  it("se insistir na descrição, a resposta passa sem travar a conversa", async () => {
    respostas = [{ content: DESCREVE }, { content: DESCREVE }];

    const result = await conversa("Quero", true);

    expect(calls).toHaveLength(2);
    expect(result.reply).toBe(DESCREVE);
    expect(result.handoff).not.toBe(true);
  });
});
