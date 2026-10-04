// Estado de venda: a promessa aberta.
//
// Production 03/10/2026, canal demo: a Lívia ofereceu demonstrar, o prospect
// aceitou três vezes ("Ss", "Continue", "Legal") e recebeu três paráfrases da
// mesma frase. O agendamento tem ConversationTask e o pedido tem draft/
// confirmed; a venda não tinha estado nenhum, então o modelo redecidia do
// zero a cada turno e voltava a oferecer o que já tinha prometido.
import { describe, expect, it, vi } from "vitest";
import type { ConversationContext, Establishment, Intent, KnowledgeBase } from "@/types";

type CompletionInput = { messages: { role: string; content?: unknown }[] };
// Acumulador em vez de variável reatribuída: o mock escreve aqui e o TypeScript
// não tem como estreitar o tipo para `never` entre a escrita e a leitura.
const completions: CompletionInput[] = [];
vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: CompletionInput) => {
    completions.push(input);
    return { content: "ok", tool_calls: undefined };
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

const { enrichCommercialContext } = await import("./commercialContext");
const { think } = await import("./brain");
const { capabilitiesForConversation } = await import("./conversationPolicy");

const comercial = (extra: Partial<ConversationContext["commercial"]> = {}): ConversationContext => ({
  purpose: "commercial", source: "prospecting", enteredAt: 100, updatedAt: 100,
  commercial: { segment: "restaurant", segmentIdentifiedAt: 100, ...extra },
});
const OFERTA = "Quer ver funcionando aqui mesmo?";

describe("abertura da promessa", () => {
  it("o aceite da oferta registra a demonstração como dívida", () => {
    const { context, changed } = enrichCommercialContext({
      context: comercial(), text: "Ss", now: 500, allowAuditQualification: false, lastBotText: OFERTA,
    });

    expect(changed).toBe(true);
    expect(context.commercial?.pendingPromise).toEqual({ kind: "practical_demo", at: 500 });
    // O segmento já conhecido não é perdido ao gravar a promessa.
    expect(context.commercial?.segment).toBe("restaurant");
  });

  it("sem oferta anterior da Lívia, um 'Ss' solto não cria dívida", () => {
    const { context } = enrichCommercialContext({
      context: comercial(), text: "Ss", now: 500, allowAuditQualification: false, lastBotText: "Como posso ajudar?",
    });

    expect(context.commercial?.pendingPromise).toBeUndefined();
  });

  it("não reabre nem move a promessa que já está aberta", () => {
    const jaAberta = comercial({ pendingPromise: { kind: "practical_demo", at: 200 } });

    const { context, changed } = enrichCommercialContext({
      context: jaAberta, text: "Continue", now: 900, allowAuditQualification: false, lastBotText: OFERTA,
    });

    expect(changed).toBe(false);
    expect(context.commercial?.pendingPromise?.at).toBe(200);
  });

  // Identificar o segmento sobrescrevia o objeto `commercial` inteiro.
  it("identificar o segmento preserva a promessa aberta", () => {
    const comPromessa = comercial({ segment: undefined, pendingPromise: { kind: "practical_demo", at: 200 } });

    const { context } = enrichCommercialContext({
      context: comPromessa, text: "tenho uma lanchonete", now: 900, allowAuditQualification: false,
    });

    expect(context.commercial?.segment).toBe("restaurant");
    expect(context.commercial?.pendingPromise).toEqual({ kind: "practical_demo", at: 200 });
  });
});

describe("a promessa no prompt", () => {
  const est = {
    id: "demo-channel", name: "Lanchonete", demoChannel: { enabled: true },
    bot: { personaName: "Lívia", tone: "objetiva", bookingEnabled: true, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
  } as unknown as Establishment;
  const intent: Intent = { type: "general_question", confidence: 1, entities: {} };

  async function promptCom(context: ConversationContext) {
    completions.length = 0;
    const demoAuthorization = { authorized: true as const, establishmentId: est.id, prospectingLeadId: "lead-1" };
    await think({
      est, kb: null as unknown as KnowledgeBase | null,
      history: [{ id: "c", role: "customer", text: "Continue", at: 300 }],
      contactPhone: "5511900000001", contactName: "Prospect", customerProfile: null, task: null,
      intent, demoAuthorization, conversationContext: context,
      prospectingContext: { status: "INTERESTED", leadId: "lead-1", segment: "lanchonete" } as never,
      capabilities: capabilitiesForConversation({ context, bookingEnabled: true, ordersEnabled: true, demoAuthorized: true }),
    });
    return String(completions[0]?.messages.find((m) => m.role === "system")?.content ?? "");
  }

  it("com dívida aberta, manda entregar agora e proíbe reabrir a oferta", async () => {
    const prompt = await promptCom(comercial({ pendingPromise: { kind: "practical_demo", at: 200 } }));

    expect(prompt).toContain("JÁ PROMETEU UMA DEMONSTRAÇÃO");
    expect(prompt).toContain("Entregue AGORA");
    expect(prompt).toContain("não pergunte se pode continuar");
  });

  it("sem dívida, o prompt não cobra entrega nenhuma", async () => {
    const prompt = await promptCom(comercial());

    expect(prompt).not.toContain("JÁ PROMETEU UMA DEMONSTRAÇÃO");
  });
});
