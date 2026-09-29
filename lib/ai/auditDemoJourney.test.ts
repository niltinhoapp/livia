// Frente A de ponta a ponta: lead que veio da Calculadora, SEM nenhuma
// ProspectingSession, recebe o diagnóstico, aceita a demonstração e usa a
// infraestrutura demo oficial (agenda e pedidos) — com escopo próprio da
// jornada e nenhum efeito real.
//
// Cada turno percorre as MESMAS funções que o webhook encadeia (resolve →
// enrich → grantAuditDemoAccess → authorizeDemo → capabilities → think), com
// tools, lib/orders e lib/scheduling reais sobre o Firestore fake. Só o modelo
// de linguagem é roteirizado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ConversationContext, Establishment, KnowledgeBase, Message } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

type ModelMessage = { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
let script: ModelMessage[] = [];
let lastTools: string[] = [];
let lastSystem = "";
vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: { messages: OpenAI.Chat.ChatCompletionMessageParam[]; tools?: OpenAI.Chat.ChatCompletionTool[] }) => {
    lastTools = input.tools?.map((t) => t.function.name) ?? [];
    lastSystem = String(input.messages.find((m) => m.role === "system")?.content ?? "");
    return script.shift() ?? { content: "Anotado!" };
  }),
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { seedDemoCatalog } from "@/lib/demo/catalog";
import { authorizeDemo, grantAuditDemoAccess, type DemoAuthorization } from "@/lib/demoAuthorization";
import { getActiveOrder, getOrder, listOrders } from "@/lib/orders";
import { defaultScheduleConfig, getAppointment, localToEpoch } from "@/lib/scheduling";
import { acceptsPracticalDemoOffer, carriesAuditResult, enrichCommercialContext, requestsDemoNow } from "./commercialContext";
import { startsAuditContext } from "./contextSwitch";
import { capabilitiesForConversation, resolveConversationContext } from "./conversationPolicy";
import { runTool, type ToolContext } from "./tools";
import { think } from "./brain";

const EST = "livia-demo-oficial";
const PHONE = "5514999887766";
const NOW = new Date("2026-10-05T17:00:00.000Z");
const DATE = "2030-01-07";
const OFFSET = -180;
const at = (minutes: number) => localToEpoch(DATE, minutes, OFFSET);

const est = {
  id: EST, name: "Canal da Lívia", ownerUid: EST, status: "active", createdAt: 0,
  demoChannel: { enabled: true },
  bot: { personaName: "Lívia", tone: "objetiva", bookingEnabled: true, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const kb: KnowledgeBase = {
  establishmentId: EST, about: "Ambiente fictício", address: null, hours: "9h às 18h",
  services: [{ name: "Corte", priceText: "R$ 80", durationText: "30 min", description: null }],
  faqs: [], notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0,
};
const CALCULADORA = "Oi Lívia! Acabei de fazer a Auditoria de Atendimento.\n\nLeads por dia: 78\nTicket médio: R$ 450\nTempo médio de resposta: Até 30 minutos\nEstimativa apresentada: R$ 52.650/mês\n\nPode me explicar esse resultado e mostrar como você poderia ajudar minha empresa?";
const OFERTA = "Pelos dados que você informou, a Calculadora estima R$ 52.650/mês. Se quiser, posso te mostrar isso funcionando aqui mesmo.";

interface Journey { context: ConversationContext | null; history: Message[]; authorization: DemoAuthorization; clock: number }
const newJourney = (): Journey => ({ context: null, history: [], authorization: { authorized: false }, clock: NOW.getTime() });

// Mesmo encadeamento do webhook para um lead SEM ProspectingSession.
async function turn(j: Journey, text: string, script_: ModelMessage[]) {
  j.clock += 1_000;
  const lastBotText = [...j.history].reverse().find((m) => m.role === "bot")?.text;
  const resolution = resolveConversationContext({ persisted: j.context, prospectingSession: null, commercialChannel: true, startsAudit: startsAuditContext(text), freshAuditEntry: carriesAuditResult(text), now: j.clock });
  const enriched = enrichCommercialContext({ context: resolution.context, text, now: j.clock, allowAuditQualification: !resolution.enteredAudit, lastBotText });
  const context = grantAuditDemoAccess({
    context: enriched.context, establishment: est, internalDemoProspectingEstablishmentId: EST, phone: PHONE,
    demoRequested: enriched.auditQualified || requestsDemoNow(text) || acceptsPracticalDemoOffer(text, lastBotText), now: j.clock,
  });
  const authorization = authorizeDemo({ establishment: est, internalDemoProspectingEstablishmentId: EST, session: null, phone: PHONE, leadId: "", context, now: j.clock });
  const capabilities = capabilitiesForConversation({ context, bookingEnabled: true, ordersEnabled: true, demoAuthorized: authorization.authorized });
  const current = await getActiveOrder(EST, PHONE);
  const history = resolution.enteredAudit ? [] : j.history.filter((m) => m.at >= context.enteredAt);
  script = script_;
  const result = await think({
    est, kb, history: [...history, { id: `c${j.clock}`, role: "customer", text, at: j.clock }],
    contactPhone: PHONE, contactName: null, customerProfile: null, task: null,
    intent: { type: "general_question", confidence: 0.5, entities: {} },
    conversationContext: context, capabilities, demoAuthorization: authorization,
    suppressBooking: !capabilities.agenda_read,
    orderAwaitingConfirmation: current?.status === "awaiting_confirmation" ? { orderId: current.id, version: current.version } : null,
  });
  j.history.push({ id: `c${j.clock}`, role: "customer", text, at: j.clock }, { id: `b${j.clock}`, role: "bot", text: result.reply, at: j.clock + 1 });
  j.context = context;
  j.authorization = authorization;
  return { result, context, authorization, capabilities };
}

const call = (name: string, args: Record<string, unknown>): ModelMessage => ({ content: null, tool_calls: [{ id: `c-${name}-${Math.random().toString(36).slice(2, 6)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const say = (content: string): ModelMessage => ({ content });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fakeDb.reset();
  fakeDb.col("establishments").set(EST, { id: EST, bot: { bookingEnabled: true, ordersEnabled: true } });
  fakeDb.col(`establishments/${EST}/conversations`).set(PHONE, { id: PHONE });
  await seedDemoCatalog(EST);
});
afterEach(() => vi.useRealTimers());

async function diagnosedAndAccepted() {
  const j = newJourney();
  const first = await turn(j, CALCULADORA, [say(OFERTA)]);
  const accepted = await turn(j, "sim, pode mostrar", [say("Ótimo! Para eu mostrar o fluxo certo: seu negócio trabalha com agendamentos ou com pedidos?")]);
  return { j, first, accepted };
}

describe("A — Calculadora → diagnóstico → aceite → demo, sem ProspectingSession", () => {
  it("A1/A3/A5/A6/A8: primeiro turno explica o diagnóstico e oferece demonstração, sem autorizar demo", async () => {
    const j = newJourney();
    const { result, context, authorization, capabilities } = await turn(j, CALCULADORA, [say(OFERTA)]);
    expect(context).toMatchObject({ purpose: "audit", source: "audit_calculator", audit: { leadsPerDay: 78, estimatedOpportunityCentsPerMonth: 5_265_000 } });
    expect(context.demoAccess).toBeUndefined();
    expect(authorization.authorized).toBe(false);
    expect(capabilities).toMatchObject({ demo_execution: false, agenda_read: false, order_mutate: false });
    expect(lastTools).not.toContain("add_order_item");
    expect(lastTools).not.toContain("create_appointment");
    expect(lastSystem).toContain("25% se perde");
    expect(result).toMatchObject({ handoff: false, reply: OFERTA });
  });

  it("A9/A10: 'sim' à oferta concede acesso demo da própria jornada e libera as ferramentas demo", async () => {
    const { j, accepted } = await diagnosedAndAccepted();
    const leadId = `audit_${PHONE}_${NOW.getTime() + 1_000}`;
    expect(accepted.context).toMatchObject({ purpose: "commercial", source: "audit_calculator", demoAccess: { leadId } });
    expect(accepted.authorization).toEqual({ authorized: true, establishmentId: EST, prospectingLeadId: leadId });
    expect(accepted.capabilities).toMatchObject({ demo_execution: true, agenda_mutate: true, order_mutate: true, customer_profile_read: false });
    expect(lastTools).toEqual(expect.arrayContaining(["find_available_appointments", "create_appointment", "add_order_item", "confirm_order"]));
    expect(lastSystem).toContain("DEMONSTRE executando as ferramentas agora");
    // A não depende de B: nenhuma ProspectingSession existe nem é criada.
    expect(fakeDb.col(`establishments/${EST}/prospectingSessions`).size).toBe(0);
    expect(j.context?.audit?.leadsPerDay).toBe(78);
  });

  it("A12/A13/A14: pedido demo completo com resumo canônico e confirmação — escopo da jornada, nada na operação real, e a conversa volta ao comercial", async () => {
    const { j, accepted } = await diagnosedAndAccepted();
    const leadId = accepted.authorization.authorized ? accepted.authorization.prospectingLeadId : "";

    await turn(j, "tenho uma lanchonete, quero ver um pedido", [call("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }), say("Adicionei 1 X-Burger. Retirada ou entrega?")]);
    await turn(j, "retirada", [call("set_order_fulfillment", { fulfillment: "pickup" }), say("Retirada. Como vai pagar?")]);
    const summary = await turn(j, "pix", [call("set_order_payment", { method: "pix" }), call("prepare_order_confirmation", {})]);
    expect(summary.result.reply).toContain("Confira seu pedido");

    const awaiting = await getActiveOrder(EST, PHONE);
    expect(awaiting).toMatchObject({ status: "awaiting_confirmation", mode: "demo", prospectingLeadId: leadId });
    const done = await turn(j, "sim", [call("confirm_order", {})]);

    expect(done.result.reply).toContain("este pedido é demonstrativo");
    expect(done.result.reply).toContain("Quer ver outra parte funcionando ou prefere saber como começar?");
    expect(await getOrder(EST, awaiting!.id)).toMatchObject({ status: "confirmed", mode: "demo", prospectingLeadId: leadId });
    expect(await listOrders(EST)).toEqual([]);
  });

  it("A11/A13: agenda demo — consultar, agendar, remarcar e cancelar com a autorização da jornada, sem ProspectingSession e sem bloquear a agenda real", async () => {
    const { j, accepted } = await diagnosedAndAccepted();
    const leadId = accepted.authorization.authorized ? accepted.authorization.prospectingLeadId : "";
    const demoCtx: ToolContext = {
      est, kb, config: { ...defaultScheduleConfig(EST), leadHours: 0 }, contactPhone: PHONE, contactName: null, offset: OFFSET,
      customerProfile: null, discussedDate: DATE, conversationContext: j.context!, capabilities: accepted.capabilities, demoAuthorization: accepted.authorization,
    };
    expect(demoCtx.prospectingContext).toBeUndefined();

    const demoSlots = ((await runTool("find_available_appointments", { date: DATE, serviceName: "Corte" }, demoCtx)).data as { slots: { time: string; startAt: number }[] }).slots;
    expect(demoSlots.length).toBeGreaterThan(1);
    const [first, second] = demoSlots;
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: first!.startAt }, demoCtx)).toMatchObject({ ok: true });
    const mine = ((await runTool("get_customer_appointments", {}, demoCtx)).data as { appointments: { id: string }[] }).appointments;
    expect(mine).toHaveLength(1);
    expect(await getAppointment(EST, mine[0]!.id)).toMatchObject({ mode: "demo", prospectingLeadId: leadId });

    expect(await runTool("reschedule_appointment", { appointmentId: mine[0]!.id, newStartAt: second!.startAt }, demoCtx)).toMatchObject({ ok: true });
    expect(await getAppointment(EST, mine[0]!.id)).toMatchObject({ startAt: second!.startAt, mode: "demo" });

    // Visão real (produção) do mesmo telefone: não enxerga o agendamento demo
    // e o horário continua livre para clientes reais.
    const operational: ConversationContext = { purpose: "operational", source: "normal", enteredAt: 0, updatedAt: 0 };
    const realCtx: ToolContext = { ...demoCtx, conversationContext: operational, demoAuthorization: { authorized: false }, capabilities: capabilitiesForConversation({ context: operational, bookingEnabled: true, ordersEnabled: true, demoAuthorized: false }) };
    expect(((await runTool("get_customer_appointments", {}, realCtx)).data as { appointments: unknown[] }).appointments).toEqual([]);
    const realSlots = ((await runTool("find_available_appointments", { date: DATE, serviceName: "Corte" }, realCtx)).data as { slots: { time: string }[] }).slots.map((s) => s.time);
    expect(realSlots).toContain(second!.time);

    expect(await runTool("cancel_appointment", { appointmentId: mine[0]!.id }, demoCtx)).toMatchObject({ ok: true });
    expect(await getAppointment(EST, mine[0]!.id)).toMatchObject({ status: "cancelled", mode: "demo" });
  });

  it("A15: recusa da oferta é respeitada — sem demo, sem acesso e sem transferir", async () => {
    const j = newJourney();
    await turn(j, CALCULADORA, [say(OFERTA)]);
    const declined = await turn(j, "agora não, obrigado", [say("Sem problema! Se quiser, depois te explico como funciona a contratação.")]);
    expect(declined.context).toMatchObject({ purpose: "audit" });
    expect(declined.context.demoAccess).toBeUndefined();
    expect(declined.authorization.authorized).toBe(false);
    expect(declined.result.handoff).toBe(false);
  });

  it("A4: um resultado novo da Calculadora depois da demo abre jornada nova e não herda o acesso demo", async () => {
    const { j } = await diagnosedAndAccepted();
    expect(j.context?.demoAccess).toBeDefined();
    const again = await turn(j, CALCULADORA.replace("Leads por dia: 78", "Leads por dia: 10").replace("R$ 52.650", "R$ 6.750"), [say("Vi o novo resultado.")]);
    expect(again.context).toMatchObject({ purpose: "audit", audit: { leadsPerDay: 10 } });
    expect(again.context.demoAccess).toBeUndefined();
    expect(again.authorization.authorized).toBe(false);
  });
});
