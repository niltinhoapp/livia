// Integração F2 + F3: a policy/contexto comercial escolhe QUANDO demonstrar;
// as tools e o ambiente oficial da F2 continuam sendo o único COMO.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ConversationContext, Establishment, KnowledgeBase, Message } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

let completionInput: { messages: OpenAI.Chat.ChatCompletionMessageParam[] } | null = null;
vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: typeof completionInput) => {
    completionInput = input;
    const prompt = input?.messages.find((message) => message.role === "system")?.content;
    return {
      content: typeof prompt === "string" && prompt.includes("INFORMAÇÕES DO ESTABELECIMENTO")
        ? "O corte custa R$ 80."
        : "Resposta deliberadamente sem preço.",
      tool_calls: undefined,
    };
  }),
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { seedDemoCatalog } from "@/lib/demo/catalog";
import { defaultDemoScenario, demoScenarioSlotsForDate } from "@/lib/demo/scenario";
import { authorizeDemo } from "@/lib/demoAuthorization";
import { defaultScheduleConfig, getAppointment, localToEpoch } from "@/lib/scheduling";
import { enrichCommercialContext } from "./commercialContext";
import { capabilitiesForConversation, historyForConversationContext, hasCapability } from "./conversationPolicy";
import { runTool, toolsFor, type ToolContext } from "./tools";
import { think } from "./brain";

const EST = "integrated-demo";
const DATE = "2030-01-07";
const OFFSET = -180;
const NOW = new Date("2026-10-05T17:00:00.000Z");
const A = { lead: "lead-a", phone: "5511900000001" };
const B = { lead: "lead-b", phone: "5511900000002" };
const at = (minutes: number) => localToEpoch(DATE, minutes, OFFSET);

const est = {
  id: EST,
  name: "Estabelecimento Operacional",
  demoChannel: { enabled: true },
  bot: { personaName: "Lívia", tone: "objetiva", bookingEnabled: true, ordersEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;
const kb: KnowledgeBase = {
  establishmentId: EST,
  about: "Salão real",
  address: null,
  hours: "9h às 18h",
  services: [{ name: "Corte", priceText: "R$ 80", durationText: "30 min", description: null }],
  faqs: [], notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0,
};
const config = { ...defaultScheduleConfig(EST), leadHours: 0 };
const prospectingContext = (leadId: string) => ({ status: "INTERESTED", leadId, segment: "salão" }) as never;
const authorization = (leadId: string) => ({ authorized: true as const, establishmentId: EST, prospectingLeadId: leadId });

function commercialContext(source: ConversationContext["source"] = "prospecting"): ConversationContext {
  return { purpose: "commercial", source, enteredAt: 100, updatedAt: 100, commercial: { segment: "salon", segmentIdentifiedAt: 100 } };
}

function toolContext(context: ConversationContext, lead = A.lead, phone = A.phone, authorized = true): ToolContext {
  const demoAuthorization = authorized ? authorization(lead) : { authorized: false as const };
  return {
    est, kb, config, contactPhone: phone, contactName: "Prospect", offset: OFFSET,
    customerProfile: null, discussedDate: DATE,
    conversationContext: context,
    prospectingContext: prospectingContext(lead),
    demoAuthorization,
    capabilities: capabilitiesForConversation({ context, bookingEnabled: true, ordersEnabled: true, demoAuthorized: demoAuthorization.authorized }),
  };
}

async function brain(context: ConversationContext, text: string, authorized = false) {
  const demoAuthorization = authorized ? authorization(A.lead) : { authorized: false as const };
  const capabilities = capabilitiesForConversation({ context, bookingEnabled: true, ordersEnabled: true, demoAuthorized: demoAuthorization.authorized });
  return think({
    est, kb,
    history: [{ id: "current", role: "customer", text, at: 300 }],
    contactPhone: A.phone, contactName: "Prospect", customerProfile: null, task: null,
    intent: { type: "ask_price", confidence: 1, entities: {} },
    prospectingContext: authorized ? prospectingContext(A.lead) : undefined,
    demoAuthorization, conversationContext: context, capabilities,
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  completionInput = null;
  fakeDb.reset();
  fakeDb.col("establishments").set(EST, { id: EST, bot: { bookingEnabled: true, ordersEnabled: true } });
  fakeDb.col(`establishments/${EST}/conversations`).set(A.phone, { id: A.phone });
  fakeDb.col(`establishments/${EST}/conversations`).set(B.phone, { id: B.phone });
});

afterEach(() => vi.useRealTimers());

describe("F2 + F3", () => {
  it("Commercial de salão oferece foco relevante e consulta a agenda fictícia somente com autorização", async () => {
    const context = commercialContext();
    await brain(context, "Tenho um salão. Pode demonstrar a agenda?", true);
    const prompt = completionInput?.messages.find((message) => message.role === "system")?.content;
    expect(prompt).toContain("horários e agenda");
    expect(prompt).toContain("demo_execution está autorizada");

    const result = await runTool("find_available_appointments", { date: DATE, serviceName: "Corte" }, toolContext(context));
    expect(result.ok).toBe(true);
    const livres = (result.data as { slots: { time: string }[] }).slots.map((slot) => slot.time);
    for (const occupied of demoScenarioSlotsForDate(defaultDemoScenario(EST), DATE)) expect(livres).not.toContain(occupied.time);
  });

  it("Commercial sem autorização não recebe nem executa agenda demo", async () => {
    const context = commercialContext();
    const ctx = toolContext(context, A.lead, A.phone, false);
    expect(hasCapability(ctx.capabilities!, "demo_execution")).toBe(false);
    expect(toolsFor(ctx).map((tool) => tool.function.name)).not.toContain("find_available_appointments");
    expect(await runTool("find_available_appointments", { date: DATE }, ctx)).toMatchObject({ ok: false });
  });

  it("Audit mantém diagnóstico, identifica restaurante e usa o catálogo oficial após qualificação legítima", async () => {
    const initial: ConversationContext = { purpose: "audit", source: "audit_calculator", enteredAt: 100, updatedAt: 100 };
    const diagnosed = enrichCommercialContext({
      context: initial,
      text: "Leads por dia: 20 Ticket médio: R$150 Tempo médio: 2 horas Estimativa: R$12.000/mês Tenho um restaurante",
      now: 100,
      allowAuditQualification: false,
    });
    const qualified = enrichCommercialContext({ context: diagnosed.context, text: "Quero continuar a demonstração", now: 200, allowAuditQualification: true });
    expect(qualified.context).toMatchObject({
      purpose: "commercial", source: "audit_calculator", enteredAt: 100,
      commercial: { segment: "restaurant" },
      audit: { leadsPerDay: 20, averageTicketCents: 15_000, responseTimeText: "2 horas", estimatedOpportunityCentsPerMonth: 1_200_000 },
    });

    const authorized = authorizeDemo({
      establishment: est,
      internalDemoProspectingEstablishmentId: EST,
      session: {
        establishmentId: EST, normalizedPhone: A.phone, leadId: A.lead,
        status: "INTERESTED", expiresAt: Date.now() + 60_000,
      } as never,
      phone: A.phone,
      leadId: A.lead,
    });
    expect(authorized).toEqual(authorization(A.lead));
    expect(capabilitiesForConversation({ context: qualified.context, bookingEnabled: true, ordersEnabled: true, demoAuthorized: authorized.authorized }).demo_execution).toBe(true);

    await seedDemoCatalog(EST);
    const menu = await runTool("list_menu", {}, toolContext(qualified.context));
    const products = (menu.data as { categories: { products: { name: string; basePriceCents: number }[] }[] }).categories.flatMap((category) => category.products);
    expect(products.find((product) => product.name === "X-Burger")).toMatchObject({ basePriceCents: 2400 });
  });

  it("separa mensalidade da Lívia, preço do catálogo demo e preço operacional", async () => {
    expect((await brain(commercialContext(), "Quanto custa?")).reply).toMatch(/R\$\s*129/);

    await seedDemoCatalog(EST);
    const restaurant = { ...commercialContext(), commercial: { segment: "restaurant" as const, segmentIdentifiedAt: 100 } };
    const catalogReply = await brain(restaurant, "Quanto custa o X-Burger?", true);
    expect(catalogReply.reply).toMatch(/X-Burger.*R\$\s*24/);
    expect(catalogReply.reply).not.toMatch(/R\$\s*129/);
    expect(catalogReply.toolCalls).toContainEqual({ name: "search_menu", args: { query: "X-Burger" } });

    const operational: ConversationContext = { purpose: "operational", source: "normal", enteredAt: 1, updatedAt: 1 };
    const operationalReply = await brain(operational, "Quanto custa?");
    expect(operationalReply.reply).toContain("R$ 80");
    expect(operationalReply.reply).not.toMatch(/R\$\s*129/);
  });

  it("demo comercial não acessa customer profile real e chamada forjada falha fechada", async () => {
    fakeDb.col(`establishments/${EST}/customers`).set(A.phone, { phone: A.phone, establishmentId: EST, name: "Nome Real" });
    const ctx = toolContext(commercialContext());
    expect(toolsFor(ctx).map((tool) => tool.function.name)).not.toContain("get_customer_profile");
    expect(await runTool("get_customer_profile", {}, ctx)).toMatchObject({ ok: false });
  });

  it("agenda demo afeta somente o próprio prospect e preserva o baseline F2", async () => {
    const context = commercialContext();
    const ctxA = toolContext(context, A.lead, A.phone);
    const ctxB = toolContext(context, B.lead, B.phone);
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctxA)).toMatchObject({ ok: true });
    const stored = (await runTool("get_customer_appointments", {}, ctxA)).data as { appointments: { id: string }[] };
    expect(await getAppointment(EST, stored.appointments[0]!.id)).toMatchObject({ mode: "demo", prospectingLeadId: A.lead });
    expect(((await runTool("get_customer_appointments", {}, ctxB)).data as { appointments: unknown[] }).appointments).toEqual([]);
    const slotsB = ((await runTool("find_available_appointments", { date: DATE }, ctxB)).data as { slots: { time: string }[] }).slots;
    expect(slotsB.map((slot) => slot.time)).toContain("10:00");
  });

  it("pedido demo fica escopado por lead e não entra na operação real", async () => {
    await seedDemoCatalog(EST);
    const context = { ...commercialContext(), commercial: { segment: "restaurant" as const, segmentIdentifiedAt: 100 } };
    const ctxA = toolContext(context, A.lead, A.phone);
    const ctxB = toolContext(context, B.lead, B.phone);
    const added = await runTool("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }, ctxA);
    expect(added).toMatchObject({ ok: true });
    const { getActiveOrder, listOrders } = await import("@/lib/orders");
    const order = (await getActiveOrder(EST, A.phone))!;
    expect(order).toMatchObject({ mode: "demo", prospectingLeadId: A.lead });
    expect(await runTool("get_order_status", { orderId: order.id }, ctxB)).toMatchObject({ ok: false });
    expect(await listOrders(EST)).toEqual([]);
  });

  it("Audit multi-turn continua comercial após a demo e mantém o boundary", () => {
    const audit: ConversationContext = {
      purpose: "commercial", source: "audit_calculator", enteredAt: 100, updatedAt: 300,
      commercial: { segment: "restaurant", segmentIdentifiedAt: 150 },
      audit: { leadsPerDay: 20, capturedAt: 100 },
    };
    const history: Message[] = [
      { id: "old", role: "bot", text: "Qual horário do cliente?", at: 1 },
      { id: "audit", role: "customer", text: "Fiz a Auditoria", at: 100 },
      { id: "demo", role: "bot", text: "Este é o cardápio demonstrativo", at: 250 },
      { id: "after", role: "customer", text: "E como contrato?", at: 300 },
    ];
    expect(historyForConversationContext(history, { context: audit, enteredAudit: false }).map((message) => message.id)).toEqual(["audit", "demo", "after"]);
    expect(audit).toMatchObject({ purpose: "commercial", source: "audit_calculator", audit: { leadsPerDay: 20 } });
    expect(capabilitiesForConversation({ context: audit, bookingEnabled: true, ordersEnabled: true, demoAuthorized: true }).demo_execution).toBe(true);
  });

  it("Audit ainda não qualificado recusa tool forjada mesmo com autorização F2 válida", async () => {
    const audit: ConversationContext = { purpose: "audit", source: "audit_calculator", enteredAt: 100, updatedAt: 100 };
    const ctx = toolContext(audit);
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctx)).toMatchObject({ ok: false });
    expect(await runTool("add_order_item", { productId: "demo-prod-xburger", quantity: 1 }, ctx)).toMatchObject({ ok: false });
  });
});
