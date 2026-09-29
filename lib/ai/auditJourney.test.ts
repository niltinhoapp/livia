// Jornada Auditoria/Calculadora → Lívia (e o comercial que nasce dela).
//
// Bug real: a mensagem pré-preenchida do CTA ("Acabei de fazer a Auditoria de
// Atendimento. Leads por dia: 78 ...") recebia "Posso chamar uma pessoa da
// equipe para te ajudar com isso?". Causa: as travas de desfecho de AGENDA
// (deniesBooking/claimsAvailableSlots/claimsIncapacity) rodavam num contexto
// sem agenda. Uma explicação natural ("enquanto sua equipe está ocupada",
// "fora do horário de atendimento") era lida como "horário ocupado inventado";
// a correção pedia find_available_appointments — que Audit não oferece — e a
// segunda tentativa virava handoff.
//
// O contexto aqui é montado pelas funções REAIS (resolveConversationContext +
// enrichCommercialContext), como no webhook; só o modelo é roteirizado.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ConversationContext, Establishment, KnowledgeBase, Message } from "@/types";

type ModelMessage = { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
let script: ModelMessage[] = [];
const calls: { messages: OpenAI.Chat.ChatCompletionMessageParam[]; tools?: OpenAI.Chat.ChatCompletionTool[] }[] = [];
vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: { messages: OpenAI.Chat.ChatCompletionMessageParam[]; tools?: OpenAI.Chat.ChatCompletionTool[] }) => {
    calls.push({ messages: [...input.messages], tools: input.tools });
    return script.shift() ?? { content: "Posso te explicar melhor?" };
  }),
}));
vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: vi.fn(async (establishmentId: string) => ({ establishmentId, utcOffsetMinutes: -180, defaultDurationMin: 30, slotMinutes: 30, days: {} })),
  localToEpoch: vi.fn(),
  assertBookable: vi.fn(),
}));
vi.mock("@/lib/repo", () => ({ getCustomerProfile: vi.fn(async () => null), upsertCustomerProfile: vi.fn(async () => undefined) }));

const { think } = await import("./brain");
const { capabilitiesForConversation, resolveConversationContext } = await import("./conversationPolicy");
const { carriesAuditResult, enrichCommercialContext } = await import("./commercialContext");
const { startsAuditContext } = await import("./contextSwitch");

const est = {
  id: "livia-demo",
  name: "Canal da Lívia",
  demoChannel: { enabled: true },
  bot: { personaName: "Lívia", tone: "objetiva", bookingEnabled: true, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const kb = null as unknown as KnowledgeBase;
const PHONE = "5514999990000";

function calculatorMessage(leads: number, ticket: string, time: string, estimate: string): string {
  return `Oi Lívia! Acabei de fazer a Auditoria de Atendimento.\nLeads por dia: ${leads}\nTicket médio: R$ ${ticket}\nTempo médio de resposta: ${time}\nEstimativa apresentada: R$ ${estimate}/mês\nPode me explicar esse resultado e mostrar como você poderia ajudar minha empresa?`;
}
const TRANSCRIPT = calculatorMessage(78, "450", "Até 30 minutos", "52.650");

// Mesmo caminho do webhook: resolve o papel e extrai os dados rotulados.
function contextFor(text: string, persisted: ConversationContext | null = null, now = 1_000): { context: ConversationContext; enteredAudit: boolean } {
  const resolution = resolveConversationContext({
    persisted,
    commercialChannel: true,
    startsAudit: startsAuditContext(text),
    freshAuditEntry: carriesAuditResult(text),
    now,
  });
  const enriched = enrichCommercialContext({ context: resolution.context, text, now, allowAuditQualification: !resolution.enteredAudit });
  return { context: enriched.context, enteredAudit: resolution.enteredAudit };
}

async function run(context: ConversationContext, history: Message[], opts: { demoAuthorized?: boolean; prospecting?: boolean } = {}) {
  const capabilities = capabilitiesForConversation({ context, bookingEnabled: true, ordersEnabled: true, demoAuthorized: Boolean(opts.demoAuthorized) });
  return think({
    est, kb, history, contactPhone: PHONE, contactName: null, customerProfile: null, task: null,
    intent: { type: "general_question", confidence: 0.5, entities: {} },
    conversationContext: context,
    capabilities,
    suppressBooking: !capabilities.agenda_read,
    ...(opts.prospecting
      ? {
          prospectingContext: { status: "REVEALED", leadId: "lead-1", businessName: "Clínica X", segment: "clínica", initialManualMessage: "Oi", preRevealReplyCount: 1 } as never,
          demoAuthorization: opts.demoAuthorized ? { authorized: true as const, establishmentId: est.id, prospectingLeadId: "lead-1" } : { authorized: false as const },
        }
      : {}),
  });
}

const customer = (text: string, at = 1_000): Message => ({ id: `c-${at}`, role: "customer", text, at });
const bot = (text: string, at: number): Message => ({ id: `b-${at}`, role: "bot", text, at });
const systemPrompt = () => String(calls[0]?.messages.find((m) => m.role === "system")?.content ?? "").replace(/ /g, " ");
const correctionMessages = () => calls.flatMap((c) => c.messages.filter((m, i) => m.role === "system" && i > 0).map((m) => String(m.content)));

beforeEach(() => {
  script = [];
  calls.length = 0;
});

describe("A — Auditoria/Calculadora: reconhecimento e explicação", () => {
  it("A1/A6: lead novo com a mensagem real do transcript recebe a explicação, não a oferta de humano", async () => {
    const { context, enteredAudit } = contextFor(TRANSCRIPT);
    expect(context).toMatchObject({ purpose: "audit", source: "audit_calculator", audit: { leadsPerDay: 78, averageTicketCents: 45_000, responseTimeText: "Até 30 minutos", estimatedOpportunityCentsPerMonth: 5_265_000 } });
    expect(enteredAudit).toBe(true);

    const explanation = "Esses R$ 52.650/mês equivalem a cerca de 117 vendas do seu ticket. Quando o cliente espera 30 minutos, ou chega fora do horário de atendimento enquanto sua equipe está ocupada, a venda esfria. Eu respondo na hora, 24h. Qual é o seu segmento?";
    script = [{ content: explanation }];
    const result = await run(context, [customer(TRANSCRIPT)]);

    expect(result.handoff).toBe(false);
    expect(result.reply).toBe(explanation);
    expect(calls).toHaveLength(1);
    expect(correctionMessages()).toEqual([]);
    expect(systemPrompt()).toContain("NA RESPOSTA ATUAL, comece pelo resultado/diagnóstico recebido");
  });

  it.each([
    "Enquanto sua equipe está ocupada atendendo no balcão, o lead espera — eu respondo na hora.",
    "Muitos leads chegam fora do horário de atendimento; eu atendo 24h.",
    "Se você está indisponível por 30 minutos, o cliente procura outro.",
    "Quem escreve fora do expediente fica sem resposta até o dia seguinte.",
    "Quando não há vaga na agenda da equipe para responder, o cliente desiste.",
  ])("A7: linguagem natural do diagnóstico não aciona trava de agenda nem handoff: %s", async (reply) => {
    const { context } = contextFor(TRANSCRIPT);
    script = [{ content: reply }, { content: reply }];
    const result = await run(context, [customer(TRANSCRIPT)]);
    expect(result).toMatchObject({ handoff: false, reply });
    expect(correctionMessages()).toEqual([]);
  });

  // Valores produzidos pela Calculadora real (calculadora-livia/index.html:249-258):
  // potencial = leads × 30 × 20% × ticket; estimativa = potencial × (1 − aproveitado).
  it.each([
    // leads, ticket, tempo, estimativa exibida, vendas potenciais, potencial, % perdido, vendas perdidas
    [78, "450", "Até 30 minutos", "52.650", "468", "R$ 210.600", "25%", "117"],
    [10, "199", "Até 30 minutos", "2.985", "60", "R$ 11.940", "25%", "15"],
    [50, "1.200", "Cerca de 1 hora", "180.000", "300", "R$ 360.000", "50%", "150"],
    [200, "80", "Mais de 2 horas", "72.000", "1.200", "R$ 96.000", "75%", "900"],
    [12, "300", "No dia seguinte", "19.440", "72", "R$ 21.600", "90%", "64,8"],
  ])("A2/A8: %i leads, ticket R$ %s, %s → explicação pelo modelo real da Calculadora", async (leads, ticket, time, estimate, potentialSales, potential, lost, lostSales) => {
    const text = calculatorMessage(leads, ticket, time, estimate);
    const { context } = contextFor(text);
    script = [{ content: "Explico já." }];
    await run(context, [customer(text)]);
    const prompt = systemPrompt();
    expect(prompt).toContain(`Leads por dia informados: ${leads}.`);
    expect(prompt).toContain(`${leads} leads por dia × 30 dias`);
    expect(prompt).toContain(`20% desses contatos viram venda = ${potentialSales} vendas`);
    expect(prompt).toContain(`= ${potential} de potencial por mês`);
    expect(prompt).toContain(`e ${lost} se perde`);
    expect(prompt).toContain(`= R$ ${estimate} por mês (cerca de ${lostSales} vendas do ticket informado)`);
    expect(prompt).toContain("Fatos informados pela pessoa: leads por dia, ticket médio e tempo de resposta.");
  });

  it("A8: estimativa R$ 0 ('Até 5 minutos') é explicada como 100% aproveitado, sem perda inventada", async () => {
    const text = calculatorMessage(85, "1.560", "Até 5 minutos", "0");
    const { context } = contextFor(text);
    script = [{ content: "Com esse tempo de resposta a Calculadora não projetou perda." }];
    await run(context, [customer(text)]);
    expect(systemPrompt()).toContain("considera 100% do potencial aproveitado — por isso a estimativa é R$ 0");
    expect(systemPrompt()).not.toContain("se perde:");
  });

  it("A2: números que não fecham com o modelo real não recebem decomposição inventada", async () => {
    const text = calculatorMessage(78, "450", "Até 30 minutos", "99.999");
    const { context } = contextFor(text);
    script = [{ content: "Explico já." }];
    await run(context, [customer(text)]);
    expect(systemPrompt()).toContain("não fecham com o modelo conhecido");
    expect(systemPrompt()).not.toContain("20% desses contatos");
  });

  it("A6: o roteiro consultivo pede explicar, conectar a dor e oferecer demonstração", async () => {
    const { context } = contextFor(TRANSCRIPT);
    script = [{ content: "Explico já." }];
    await run(context, [customer(TRANSCRIPT)]);
    const prompt = systemPrompt();
    expect(prompt).toContain("vendedora consultiva da própria Lívia");
    expect(prompt).toContain("ofereça mostrar isso funcionando aqui mesmo");
    expect(prompt).toContain("sem criticar a equipe da pessoa");
    expect(prompt).not.toContain("demo_execution está autorizada");
  });

  it("A4: 'o que significa esse resultado?' no turno seguinte mantém o diagnóstico e não transfere", async () => {
    const entry = contextFor(TRANSCRIPT, null, 1_000);
    const followUp = "o que significa esse resultado?";
    const { context } = contextFor(followUp, entry.context, 2_000);
    expect(context.enteredAt).toBe(entry.context.enteredAt);
    const history = [customer(TRANSCRIPT, 1_000), bot("Esse valor é uma simulação de potencial. Qual é o seu segmento?", 1_500), customer(followUp, 2_000)];
    script = [{ content: "Significa que, com resposta em até 30 minutos, a Calculadora considera que 25% do potencial pode esfriar enquanto a equipe está ocupada." }];
    const result = await run(context, history);
    expect(result.handoff).toBe(false);
    expect(systemPrompt()).toContain("R$ 52.650 por mês (cerca de 117 vendas do ticket informado)");
    expect(systemPrompt()).not.toContain("NA RESPOSTA ATUAL, comece pelo resultado");
  });

  it("A5: 'como a Lívia pode ajudar?' — dizer que não agenda reunião por aqui não é incapacidade inventada", async () => {
    const { context } = contextFor(TRANSCRIPT);
    const reply = "Por aqui eu não consigo agendar uma reunião, mas posso te mostrar como atendo seus clientes na hora, inclusive fora do horário.";
    script = [{ content: reply }, { content: reply }];
    const result = await run(context, [customer(TRANSCRIPT), customer("como a Lívia pode ajudar minha empresa?", 1_001)]);
    expect(result).toMatchObject({ handoff: false, reply });
    expect(correctionMessages()).toEqual([]);
  });

  it("A10: Audit não oferece agenda, pedidos nem perfil, e o prompt proíbe inventar capacidade", async () => {
    const { context } = contextFor(TRANSCRIPT);
    script = [{ content: "Explico já." }];
    await run(context, [customer(TRANSCRIPT)]);
    const toolNames = calls[0]?.tools?.map((t) => t.function.name) ?? [];
    for (const name of ["find_available_appointments", "create_appointment", "add_order_item", "confirm_order", "update_customer_profile"]) {
      expect(toolNames).not.toContain(name);
    }
    expect(toolNames).toContain("request_human_handoff");
    expect(systemPrompt()).toContain("Não invente recurso, integração, resultado");
    expect(systemPrompt()).toContain("Explicar o resultado da Auditoria, o que a Lívia faz");
  });

  it("A11: pedido explícito de humano continua transferindo", async () => {
    const { context } = contextFor(TRANSCRIPT);
    script = [
      { content: null, tool_calls: [{ id: "h1", type: "function", function: { name: "request_human_handoff", arguments: JSON.stringify({ reason: "pediu humano" }) } }] },
      { content: "Claro, vou chamar uma pessoa da equipe." },
    ];
    const result = await run(context, [customer(TRANSCRIPT), customer("quero falar com uma pessoa da equipe", 1_001)]);
    expect(result.handoff).toBe(true);
  });

  it("A9: 'quero testar' depois do diagnóstico qualifica para Commercial e a conversa segue sem transferir", async () => {
    const entry = contextFor(TRANSCRIPT, null, 1_000);
    const { context } = contextFor("gostei, quero testar a Lívia", entry.context, 2_000);
    expect(context).toMatchObject({ purpose: "commercial", source: "audit_calculator", audit: { leadsPerDay: 78 } });
    const reply = "Ótimo! Enquanto sua equipe está ocupada eu sigo atendendo. Qual é o seu segmento para eu te mostrar o fluxo certo?";
    script = [{ content: reply }];
    const result = await run(context, [customer(TRANSCRIPT, 1_000), bot("Explicação do diagnóstico.", 1_500), customer("gostei, quero testar a Lívia", 2_000)]);
    expect(result).toMatchObject({ handoff: false, reply });
    expect(systemPrompt()).toContain("demo_execution NÃO está autorizada");
  });
});

describe("A2 — reentrada da Calculadora com histórico antigo", () => {
  it("resultado novo da Calculadora sobre uma Auditoria já persistida abre jornada nova, sem dados herdados", () => {
    const old = contextFor(calculatorMessage(20, "150", "2 horas", "12.000"), null, 1_000).context;
    const withSegment = enrichCommercialContext({ context: old, text: "tenho uma clínica", now: 1_100, allowAuditQualification: true }).context;
    expect(withSegment.commercial?.segment).toBe("clinic");

    const { context, enteredAudit } = contextFor(TRANSCRIPT, withSegment, 9_000);
    expect(enteredAudit).toBe(true);
    expect(context.enteredAt).toBe(9_000);
    expect(context.audit).toMatchObject({ leadsPerDay: 78, estimatedOpportunityCentsPerMonth: 5_265_000, capturedAt: 9_000 });
    expect(context.commercial).toBeUndefined();
  });

  it("uma simples menção à auditoria no meio da jornada NÃO reinicia a fronteira", () => {
    const entry = contextFor(TRANSCRIPT, null, 1_000);
    const { context, enteredAudit } = contextFor("me explica melhor o diagnóstico", entry.context, 2_000);
    expect(enteredAudit).toBe(false);
    expect(context.enteredAt).toBe(1_000);
    expect(context.audit?.leadsPerDay).toBe(78);
  });
});

describe("B — prospecção/comercial: perguntas sobre a Lívia", () => {
  it("B6/B12: prospect revelado sem demo pergunta o que a Lívia faz — resposta natural não vira handoff", async () => {
    const context: ConversationContext = { purpose: "commercial", source: "prospecting", enteredAt: 1, updatedAt: 1 };
    const reply = "Eu atendo seus clientes no WhatsApp na hora, inclusive quando a equipe está ocupada ou fora do expediente. Quer ver como seria na sua clínica?";
    script = [{ content: reply }, { content: reply }];
    const result = await run(context, [customer("o que exatamente a Lívia faz?")], { prospecting: true });
    expect(result).toMatchObject({ handoff: false, reply });
    expect(correctionMessages()).toEqual([]);
  });

  it("com demo autorizada (agenda demo em escopo) a trava de horário inventado continua valendo", async () => {
    const context: ConversationContext = { purpose: "commercial", source: "prospecting", enteredAt: 1, updatedAt: 1 };
    script = [{ content: "Esse horário das 14h está ocupado." }, { content: "Esse horário das 14h está ocupado." }];
    const result = await run(context, [customer("tem horário amanhã às 14h?")], { prospecting: true, demoAuthorized: true });
    expect(correctionMessages()[0]).toContain("NENHUMA consulta à agenda foi feita");
    expect(result.reply).not.toContain("está ocupado");
  });
});

describe("C — atendimento real: as travas de agenda seguem intactas", () => {
  it("operacional: 'horário ocupado' sem consulta à agenda continua corrigido e, se insistir, transfere", async () => {
    const context: ConversationContext = { purpose: "operational", source: "normal", enteredAt: 0, updatedAt: 0 };
    script = [{ content: "Esse horário está ocupado." }, { content: "Esse horário está ocupado." }];
    const result = await run(context, [customer("tem horário amanhã às 14h?")]);
    expect(correctionMessages()[0]).toContain("NENHUMA consulta à agenda foi feita");
    expect(result).toMatchObject({ handoff: true, reply: "Vou chamar uma pessoa da equipe pra confirmar esse horário com você." });
  });
});
