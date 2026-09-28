// F2 — ambiente oficial de demonstração, ponta a ponta pelas TOOLS REAIS.
//
// Nada aqui chama um caminho paralelo: toda operação passa por `runTool`, o
// mesmo ponto que o brain usa, com a policy da F1 no meio. É o que prova que a
// demonstração exercita o produto e não uma segunda Lívia.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { defaultScheduleConfig, getAppointment, localToEpoch } from "@/lib/scheduling";
import { runTool, type ToolContext } from "@/lib/ai/tools";
import { seedDemoCatalog } from "./catalog";
import { cleanupDemoSession, getDemoScenario, resetDemoScenario, saveDemoScenario } from "./store";
import { defaultDemoScenario, demoScenarioSlotsForDate } from "./scenario";

const EST = "est-demo";
const OFFSET = -180;
const DATE = "2030-01-07"; // segunda
const config = { ...defaultScheduleConfig(EST), leadHours: 0 };
const at = (hourMin: number) => localToEpoch(DATE, hourMin, OFFSET);

const est = {
  id: EST,
  name: "Salão Demonstração",
  bot: { bookingEnabled: true, ordersEnabled: true, personaName: "Livia", tone: "", handoffKeywords: [], medicalGuardrail: false },
} as unknown as ToolContext["est"];

// Contexto de uma sessão de demonstração autorizada. `purpose: "commercial"` +
// demoAuthorized é exatamente o que a policy da F1 exige para `demo_execution`.
function demoCtx(leadId: string, phone: string, discussedDate: string | null = DATE): ToolContext {
  return {
    est,
    kb: { services: [] },
    config,
    contactPhone: phone,
    contactName: "Prospect",
    offset: OFFSET,
    customerProfile: null,
    discussedDate,
    conversationContext: { purpose: "commercial", source: "prospecting", enteredAt: 0, updatedAt: 0 },
    prospectingContext: { status: "INTERESTED", leadId } as never,
    demoAuthorization: { authorized: true, establishmentId: EST, prospectingLeadId: leadId },
  } as unknown as ToolContext;
}

// Atendimento real do mesmo tenant: purpose operational, sem demo.
function operationalCtx(phone: string, discussedDate: string | null = DATE): ToolContext {
  return {
    est,
    kb: { services: [] },
    config,
    contactPhone: phone,
    contactName: "Cliente",
    offset: OFFSET,
    customerProfile: null,
    discussedDate,
    conversationContext: { purpose: "operational", source: "normal", enteredAt: 0, updatedAt: 0 },
  } as unknown as ToolContext;
}

// Prospect comercial SEM autorização de demo (sessão ainda não revelada).
function unauthorizedDemoCtx(leadId: string, phone: string): ToolContext {
  return {
    ...demoCtx(leadId, phone),
    demoAuthorization: { authorized: false },
  } as unknown as ToolContext;
}

const A = { lead: "lead-a", phone: "5511900000001" };
const B = { lead: "lead-b", phone: "5511900000002" };

const slots = async (ctx: ToolContext, serviceName = "Corte") => {
  const result = await runTool("find_available_appointments", { date: DATE, serviceName }, ctx);
  return result.ok ? ((result.data as { slots: { time: string }[] }).slots ?? []).map((s) => s.time) : null;
};
const occupied = async (ctx: ToolContext) => {
  const result = await runTool("find_available_appointments", { date: DATE }, ctx);
  return (result.data as { occupied?: { time: string; serviceName: string }[] }).occupied;
};
const myAppointments = async (ctx: ToolContext) => {
  const result = await runTool("get_customer_appointments", {}, ctx);
  return (result.data as { appointments: { id: string; time: string; serviceName: string }[] }).appointments;
};

// Relógio fixo dentro do expediente (segunda, 14:00 BRT).
//
// A janela de recebimento de pedidos herda o expediente canônico, como num
// tenant real, e é avaliada contra o relógio. Sem congelar, os testes de
// restaurante passariam ou falhariam conforme a hora da suíte — mesmo defeito
// corrigido em lib/orders.demoDraft.test.ts. Só `Date` é falsificado, então o
// Firestore falso e o async das tools seguem reais. A data de agendamento
// (2030-01-07) continua no futuro, então `leadHours` não interfere.
const AGORA = new Date("2026-10-05T17:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
  fakeDb.reset();
  fakeDb.col("establishments").set(EST, { id: EST, bot: { bookingEnabled: true, ordersEnabled: true } });
  fakeDb.col(`establishments/${EST}/conversations`).set(A.phone, { id: A.phone });
  fakeDb.col(`establishments/${EST}/conversations`).set(B.phone, { id: B.phone });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("1-2. acesso ao cenário depende de autorização", () => {
  it("demo autorizada consulta a agenda fictícia", async () => {
    expect(await slots(demoCtx(A.lead, A.phone))).not.toBeNull();
  });

  it("demo NÃO autorizada não alcança a agenda (fail closed pela policy da F1)", async () => {
    const ctx = unauthorizedDemoCtx(A.lead, A.phone);
    expect(await runTool("find_available_appointments", { date: DATE }, ctx)).toMatchObject({ ok: false });
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctx)).toMatchObject({ ok: false });
  });

  it("23. chamada forjada fora da policy falha mesmo com argumentos válidos", async () => {
    // Contexto de Audit: a policy nega agenda; a tool não executa nem aparece.
    const audit = {
      ...demoCtx(A.lead, A.phone),
      conversationContext: { purpose: "audit", source: "audit_calculator", enteredAt: 0, updatedAt: 0 },
    } as unknown as ToolContext;
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, audit)).toMatchObject({ ok: false });
    expect(await runTool("find_available_appointments", { date: DATE }, audit)).toMatchObject({ ok: false });
  });
});

describe("5-7. baseline consultável e reservável", () => {
  it("o cenário fictício é consultável e os horários ocupados não aparecem livres", async () => {
    const livres = (await slots(demoCtx(A.lead, A.phone)))!;
    const scenario = defaultDemoScenario(EST);
    for (const slot of demoScenarioSlotsForDate(scenario, DATE)) expect(livres).not.toContain(slot.time);
    expect(livres.length).toBeGreaterThan(0);
  });

  it("6. slot ocupado fictício é indisponível também na CRIAÇÃO (não só na listagem)", async () => {
    const ocupado = demoScenarioSlotsForDate(defaultDemoScenario(EST), DATE)[0]!;
    const [hora, minuto] = ocupado.time.split(":").map(Number);
    const criado = await runTool(
      "create_appointment",
      { serviceName: "Corte", startAt: at(hora! * 60 + minuto!) },
      demoCtx(A.lead, A.phone),
    );
    expect(criado.ok).toBe(false);
    expect(criado.reasonCode).toBe("overlap");
  });

  it("7. slot livre pode ser reservado e a operação é REAL (persistida)", async () => {
    const criado = await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, demoCtx(A.lead, A.phone));
    expect(criado).toMatchObject({ ok: true });
    const [meu] = await myAppointments(demoCtx(A.lead, A.phone));
    expect(await getAppointment(EST, meu!.id)).toMatchObject({ mode: "demo", prospectingLeadId: A.lead });
  });

  it("3. a ocupação exposta não tem PII — só hora e serviço fictício", async () => {
    const lista = (await occupied(demoCtx(A.lead, A.phone)))!;
    expect(lista.length).toBeGreaterThan(0);
    const permitidos = new Set(demoScenarioSlotsForDate(defaultDemoScenario(EST), DATE).map((s) => s.serviceName));
    for (const item of lista) {
      expect(Object.keys(item).sort()).toEqual(["serviceName", "time"]);
      expect(permitidos.has(item.serviceName)).toBe(true);
    }
  });

  it("no atendimento operacional a chave `occupied` não existe", async () => {
    expect(await occupied(operationalCtx("5511777770000"))).toBeUndefined();
  });
});

describe("8-10. isolamento entre prospects", () => {
  it("8. o agendamento criado afeta a disponibilidade da PRÓPRIA sessão", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    expect((await slots(ctx))!).toContain("10:00");
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctx)).toMatchObject({ ok: true });
    expect((await slots(ctx))!).not.toContain("10:00");
  });

  it("9-10. não afeta a sessão de outro prospect, que segue vendo o baseline", async () => {
    const ctxA = demoCtx(A.lead, A.phone);
    const ctxB = demoCtx(B.lead, B.phone);
    const baselineB = (await slots(ctxB))!;

    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctxA);

    expect((await slots(ctxB))!).toEqual(baselineB);
    expect((await slots(ctxB))!).toContain("10:00");
    // E B não enxerga o agendamento de A em lugar nenhum.
    expect(await myAppointments(ctxB)).toEqual([]);
    expect((await occupied(ctxB))!.map((o) => o.time)).not.toContain("10:00");
  });

  it("dois prospects podem reservar o MESMO horário sem se bloquearem", async () => {
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, demoCtx(A.lead, A.phone))).toMatchObject({ ok: true });
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, demoCtx(B.lead, B.phone))).toMatchObject({ ok: true });
  });
});

describe("11-12. remarcar e cancelar dentro da sessão", () => {
  it("11. remarca e a disponibilidade da sessão acompanha", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctx);
    const [meu] = await myAppointments(ctx);

    expect(await runTool("reschedule_appointment", { appointmentId: meu!.id, newStartAt: at(840) }, ctx)).toMatchObject({ ok: true });
    expect(await getAppointment(EST, meu!.id)).toMatchObject({ startAt: at(840), mode: "demo", prospectingLeadId: A.lead });
    const livres = (await slots(ctx))!;
    expect(livres).toContain("10:00");
    expect(livres).not.toContain("14:00");
  });

  it("remarcar para cima da ocupação fictícia é recusado pelo motor", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctx);
    const [meu] = await myAppointments(ctx);
    const ocupado = demoScenarioSlotsForDate(defaultDemoScenario(EST), DATE)[0]!;
    const [hora, minuto] = ocupado.time.split(":").map(Number);

    const result = await runTool("reschedule_appointment", { appointmentId: meu!.id, newStartAt: at(hora! * 60 + minuto!) }, ctx);
    expect(result.ok).toBe(false);
    expect(await getAppointment(EST, meu!.id)).toMatchObject({ startAt: at(600) });
  });

  it("12. cancela e o horário volta a ficar livre na sessão", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctx);
    const [meu] = await myAppointments(ctx);

    expect(await runTool("cancel_appointment", { appointmentId: meu!.id }, ctx)).toMatchObject({ ok: true });
    expect(await getAppointment(EST, meu!.id)).toMatchObject({ status: "cancelled" });
    expect((await slots(ctx))!).toContain("10:00");
  });

  it("outro lead não remarca nem cancela o agendamento de A", async () => {
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, demoCtx(A.lead, A.phone));
    const [meu] = await myAppointments(demoCtx(A.lead, A.phone));
    const ctxB = demoCtx(B.lead, B.phone);

    expect(await runTool("reschedule_appointment", { appointmentId: meu!.id, newStartAt: at(840) }, ctxB)).toMatchObject({ ok: false });
    expect(await runTool("cancel_appointment", { appointmentId: meu!.id }, ctxB)).toMatchObject({ ok: false });
    expect(await getAppointment(EST, meu!.id)).toMatchObject({ startAt: at(600), status: "pending" });
  });
});

describe("3-4. produção e demo nunca se cruzam", () => {
  it("o agendamento demo NÃO aparece no atendimento operacional", async () => {
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, demoCtx(A.lead, A.phone));
    // Mesmo telefone, contexto operacional: o registro demo não é dele.
    expect(await myAppointments(operationalCtx(A.phone))).toEqual([]);
  });

  it("24. a agenda operacional continua funcionando e não vê ocupação fictícia", async () => {
    const ctx = operationalCtx("5511777770000");
    const livres = (await slots(ctx))!;
    // Nenhum horário do cenário fictício bloqueia produção.
    for (const slot of demoScenarioSlotsForDate(defaultDemoScenario(EST), DATE)) expect(livres).toContain(slot.time);
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: at(540) }, ctx)).toMatchObject({ ok: true });
  });

  it("o agendamento demo não bloqueia o MESMO horário em produção", async () => {
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, demoCtx(A.lead, A.phone));
    expect(await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, operationalCtx("5511777770000"))).toMatchObject({ ok: true });
  });

  it("4. a demo nunca recebe customer profile real (policy da F1)", async () => {
    fakeDb.col(`establishments/${EST}/customers`).set(A.phone, { phone: A.phone, establishmentId: EST, name: "Nome Real" });
    expect(await runTool("get_customer_profile", {}, demoCtx(A.lead, A.phone))).toMatchObject({ ok: false });
    expect(await runTool("update_customer_profile", { preferredTime: "manhã" }, demoCtx(A.lead, A.phone))).toMatchObject({ ok: false });
    // No atendimento real continua disponível.
    expect(await runTool("get_customer_profile", {}, operationalCtx(A.phone))).toMatchObject({ ok: true });
  });
});

describe("15-20. restaurante demo sobre catálogo fictício real", () => {
  beforeEach(async () => {
    await seedDemoCatalog(EST);
  });

  it("15-16. o cardápio vem do catálogo semeado e o preço é do backend", async () => {
    const menu = await runTool("list_menu", {}, demoCtx(A.lead, A.phone));
    expect(menu.ok).toBe(true);
    const categorias = (menu.data as { categories: { name: string; products: { name: string; basePriceCents: number }[] }[] }).categories;
    expect(categorias.map((c) => c.name)).toEqual(["Lanches", "Pizzas", "Bebidas"]);
    const xburger = categorias.flatMap((c) => c.products).find((p) => p.name === "X-Burger");
    expect(xburger?.basePriceCents).toBe(2400);
  });

  it('"2 X-Burgers sem cebola e uma Coca" é montado com IDs e preços reais', async () => {
    const ctx = demoCtx(A.lead, A.phone);
    const burger = await runTool(
      "add_order_item",
      { productId: "demo-prod-xburger", quantity: 2, modifierOptionIds: ["demo-opt-sem-cebola"], __allowDraftCreation: true },
      ctx,
    );
    expect(burger).toMatchObject({ ok: true });
    const coca = await runTool("add_order_item", { productId: "demo-prod-coca", quantity: 1, variantId: "demo-var-coca-lata" }, ctx);
    expect(coca).toMatchObject({ ok: true });

    const resumo = coca.data as { items: { name: string; quantity: number; modifiers: string[]; lineTotalCents: number }[]; subtotalCents: number };
    expect(resumo.items).toHaveLength(2);
    const linhaBurger = resumo.items.find((i) => i.name === "X-Burger")!;
    expect(linhaBurger.modifiers).toEqual(["Sem cebola"]);
    // 2 x 2400 (remover não altera preço) + 1 x 800.
    expect(linhaBurger.lineTotalCents).toBe(4800);
    expect(resumo.subtotalCents).toBe(5600);
  });

  it("variação e adicional pago vêm do catálogo", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    const pizza = await runTool(
      "add_order_item",
      { productId: "demo-prod-pizza-margherita", quantity: 1, variantId: "demo-var-pizza-grande", modifierOptionIds: ["demo-opt-borda-catupiry"], __allowDraftCreation: true },
      ctx,
    );
    // 4900 + 1600 (grande) + 900 (catupiry).
    expect((pizza.data as { subtotalCents: number }).subtotalCents).toBe(7400);
  });

  it("17. item inexistente não é inventado, e grupo obrigatório é exigido", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    expect(await runTool("add_order_item", { productId: "produto-que-nao-existe", quantity: 1, __allowDraftCreation: true }, ctx)).toMatchObject({ ok: false });
    // Pizza sem escolher borda: o backend recusa.
    expect(await runTool("add_order_item", { productId: "demo-prod-pizza-margherita", quantity: 1, __allowDraftCreation: true }, ctx)).toMatchObject({ ok: false });
    expect(await runTool("search_menu", { query: "sushi" }, ctx)).toMatchObject({ ok: true, data: { products: [] } });
  });

  it("18. o pedido demo não entra na operação real", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    await runTool("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }, ctx);
    const { listOrders, transitionOrder, getActiveOrder } = await import("@/lib/orders");
    const draft = (await getActiveOrder(EST, A.phone))!;
    expect(draft.mode).toBe("demo");
    // Fila operacional do painel não mostra pedido demo.
    expect(await listOrders(EST)).toEqual([]);
    await expect(transitionOrder(EST, draft.id, "accepted", draft.version)).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("19. o pedido de A não é legível por B", async () => {
    const ctxA = demoCtx(A.lead, A.phone);
    await runTool("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }, ctxA);
    const { getActiveOrder } = await import("@/lib/orders");
    const pedidoA = (await getActiveOrder(EST, A.phone))!;

    const ctxB = demoCtx(B.lead, B.phone);
    expect(await runTool("get_order_status", { orderId: pedidoA.id }, ctxB)).toMatchObject({ ok: false });
    expect((await runTool("get_order_draft", {}, ctxB)).data).toBeNull();
  });

  it("um pedido demo não é legível no atendimento operacional", async () => {
    const ctxA = demoCtx(A.lead, A.phone);
    await runTool("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }, ctxA);
    const { getActiveOrder } = await import("@/lib/orders");
    const pedidoA = (await getActiveOrder(EST, A.phone))!;
    expect(await runTool("get_order_status", { orderId: pedidoA.id }, operationalCtx(A.phone))).toMatchObject({ ok: false });
  });

  it("20. confirmar pedido demo não gera pagamento nem notificação real", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    await runTool("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }, ctx);
    await runTool("set_order_fulfillment", { fulfillment: "pickup" }, ctx);
    await runTool("set_order_payment", { method: "pix" }, ctx);
    const preparado = await runTool("prepare_order_confirmation", {}, ctx);
    expect(preparado).toMatchObject({ ok: true });

    const pendente = preparado.data as { id: string; version: number; pixInstructions?: string };
    expect(pendente.pixInstructions).toContain("demonstração");
    const confirmado = await runTool("confirm_order", {}, { ...ctx, orderConfirmation: { orderId: pendente.id, version: pendente.version, explicitlyConfirmed: true } } as ToolContext);
    expect(confirmado).toMatchObject({ ok: true });

    const { createPaymentForOrder } = await import("@/lib/payments");
    await expect(createPaymentForOrder(EST, pendente.id)).rejects.toMatchObject({ code: "invalid_transition" });
    expect(fakeDb.col(`establishments/${EST}/orderNotifications`).size).toBe(0);
  });

  it("25. o pedido operacional continua funcionando sobre o mesmo catálogo", async () => {
    const ctx = operationalCtx("5511777770000");
    fakeDb.col(`establishments/${EST}/conversations`).set("5511777770000", { id: "5511777770000" });
    const item = await runTool("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }, ctx);
    expect(item).toMatchObject({ ok: true });
    const { getActiveOrder, listOrders } = await import("@/lib/orders");
    expect((await getActiveOrder(EST, "5511777770000"))!.mode).toBeUndefined();
    // Continua fora da fila porque ainda é draft, não porque é demo.
    expect(await listOrders(EST)).toEqual([]);
  });
});

describe("21-22. lifecycle: reset e expiração", () => {
  it("21. o reset de A não destrói a sessão de B", async () => {
    const ctxA = demoCtx(A.lead, A.phone);
    const ctxB = demoCtx(B.lead, B.phone);
    await seedDemoCatalog(EST);
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctxA);
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(840) }, ctxB);
    await runTool("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }, ctxB);

    const removidos = await cleanupDemoSession(EST, A.lead);
    expect(removidos.appointments).toBe(1);

    expect(await myAppointments(ctxA)).toEqual([]);
    expect((await myAppointments(ctxB)).map((a) => a.time)).toEqual(["14:00"]);
    const { getActiveOrder } = await import("@/lib/orders");
    expect(await getActiveOrder(EST, B.phone)).not.toBeNull();
  });

  it("22. a limpeza remove agendamento e pedido do lead, e zera o draft ativo", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    await seedDemoCatalog(EST);
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctx);
    await runTool("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }, ctx);

    const removidos = await cleanupDemoSession(EST, A.lead);
    expect(removidos).toEqual({ appointments: 1, orders: 1 });
    const { getActiveOrder } = await import("@/lib/orders");
    expect(await getActiveOrder(EST, A.phone)).toBeNull();
  });

  it("a limpeza NUNCA alcança produção", async () => {
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(540) }, operationalCtx("5511777770000"));
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, demoCtx(A.lead, A.phone));

    await cleanupDemoSession(EST, A.lead);
    expect((await myAppointments(operationalCtx("5511777770000"))).map((a) => a.time)).toEqual(["09:00"]);
  });

  it("limpeza sem leadId é no-op — nunca vira varredura global", async () => {
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, demoCtx(A.lead, A.phone));
    expect(await cleanupDemoSession(EST, "")).toEqual({ appointments: 0, orders: 0 });
    expect(await myAppointments(demoCtx(A.lead, A.phone))).toHaveLength(1);
  });

  it("o baseline sobrevive à limpeza — não é persistido", async () => {
    const ctx = demoCtx(A.lead, A.phone);
    await runTool("create_appointment", { serviceName: "Corte", startAt: at(600) }, ctx);
    await cleanupDemoSession(EST, A.lead);
    const livres = (await slots(ctx))!;
    for (const slot of demoScenarioSlotsForDate(defaultDemoScenario(EST), DATE)) expect(livres).not.toContain(slot.time);
  });
});

describe("cenário persistido: explícito e resetável", () => {
  it("sem documento, vale o default — a demo funciona antes de qualquer seed", async () => {
    expect((await getDemoScenario(EST)).weekly).toEqual(defaultDemoScenario(EST).weekly);
  });

  it("um cenário customizado muda a ocupação vista pela tool real", async () => {
    await saveDemoScenario(EST, {
      weekly: { "1": [{ time: "10:00", serviceName: "Sobrancelha", durationMin: 30 }] },
    });
    const livres = (await slots(demoCtx(A.lead, A.phone)))!;
    expect(livres).not.toContain("10:00");
    expect(livres).toContain("09:00"); // não mais ocupado no cenário customizado
    expect((await occupied(demoCtx(A.lead, A.phone)))!).toEqual([{ time: "10:00", serviceName: "Sobrancelha" }]);
  });

  it("o reset volta ao cenário default", async () => {
    await saveDemoScenario(EST, { weekly: { "1": [] } });
    expect((await slots(demoCtx(A.lead, A.phone)))!).toContain("09:00");
    await resetDemoScenario(EST);
    expect((await slots(demoCtx(A.lead, A.phone)))!).not.toContain("09:00");
  });
});
