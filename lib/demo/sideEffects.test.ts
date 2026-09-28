// F2 — nenhum registro de demonstração produz consequência comercial real.
//
// A F0 fechou o lembrete; a F2 fecha o último efeito externo que restava
// (métricas, e por consequência o resumo diário enviado ao dono por template).
// Este arquivo trava a auditoria completa desses caminhos num só lugar, para
// que um consumidor novo de Appointment não reabra o vazamento em silêncio.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { isDemoAppointment } from "@/lib/scheduling";
import { materializeDemoBaseline } from "./scenario";
import { defaultDemoScenario } from "./scenario";
import type { Appointment } from "@/types";

const EST = "est-demo";
const HOJE = Date.now();

function appointment(over: Partial<Appointment> = {}): Appointment {
  return {
    id: over.id ?? "appt",
    establishmentId: EST,
    contactPhone: "5511900000001",
    contactName: "Cliente",
    serviceName: "Corte",
    startAt: HOJE + 6 * 3600000,
    durationMin: 30,
    status: "pending",
    source: "bot",
    note: null,
    createdAt: HOJE,
    confirmedAt: null,
    reminderSentAt: null,
    ...over,
  } as Appointment;
}

const demo = (over: Partial<Appointment> = {}) =>
  appointment({ id: "appt-demo", mode: "demo", prospectingLeadId: "lead-a", ...over });

beforeEach(() => {
  fakeDb.reset();
});

describe("classificação", () => {
  it("o baseline materializado é reconhecido como demo", () => {
    const baseline = materializeDemoBaseline(defaultDemoScenario(EST), "2026-10-05", -180);
    expect(baseline.length).toBeGreaterThan(0);
    for (const a of baseline) expect(isDemoAppointment(a)).toBe(true);
  });

  it("agendamento sem `mode` continua sendo produção", () => {
    const legado = appointment();
    delete (legado as { mode?: unknown }).mode;
    expect(isDemoAppointment(legado)).toBe(false);
  });
});

describe("métricas e resumo do dono nunca contam demonstração", () => {
  // getDashboardMetrics alimenta /painel e o cron daily-owner-summary, que
  // envia TEMPLATE real ao dono. Um agendamento demo inflando "agendamentos
  // criados hoje" seria um efeito externo real de um dado fictício.
  async function metrics(appointments: Appointment[]) {
    for (const a of appointments) fakeDb.col(`establishments/${EST}/appointments`).set(a.id, { ...a });
    fakeDb.col("establishments").set(EST, { id: EST, bot: {} });
    const { getDashboardMetrics } = await import("@/lib/dashboard");
    const inicioDeHoje = HOJE - 3600000;
    return getDashboardMetrics(EST, inicioDeHoje, HOJE + 3600000);
  }

  it("agendamento real conta em agendamentosCriadosHoje", async () => {
    const result = await metrics([appointment({ id: "appt-real" })]);
    expect(result.agendamentosCriadosHoje).toBe(1);
  });

  it("agendamento demo NÃO conta", async () => {
    const result = await metrics([demo()]);
    expect(result.agendamentosCriadosHoje).toBe(0);
  });

  it("mistura: somente o real conta", async () => {
    const result = await metrics([appointment({ id: "appt-real" }), demo(), demo({ id: "appt-demo-2", prospectingLeadId: "lead-b" })]);
    expect(result.agendamentosCriadosHoje).toBe(1);
  });

  it("cancelamento demo não conta como cancelamento do dia", async () => {
    const result = await metrics([
      demo({ id: "appt-demo-cancel", status: "cancelled", cancelledAt: HOJE }),
    ]);
    expect(result.cancelamentosHoje).toBe(0);
  });

  it("cancelamento real continua contando", async () => {
    const result = await metrics([
      appointment({ id: "appt-real-cancel", status: "cancelled", cancelledAt: HOJE }),
    ]);
    expect(result.cancelamentosHoje).toBe(1);
  });
});

describe("oportunidades não são derivadas de demonstração", () => {
  it("um agendamento demo não marca o contato como tendo horário ativo", async () => {
    // `price_inquiry_no_booking` só existe quando o contato NÃO tem
    // agendamento ativo. Um registro demo não pode mascarar essa lacuna real.
    fakeDb.col("establishments").set(EST, { id: EST, bot: {} });
    fakeDb.col(`establishments/${EST}/appointments`).set("appt-demo", { ...demo({ startAt: HOJE + 24 * 3600000 }) });
    fakeDb.col(`establishments/${EST}/conversations`).set("5511900000001", {
      id: "5511900000001",
      establishmentId: EST,
      contactPhone: "5511900000001",
      contactName: "Cliente",
      status: "bot",
      lastIntent: "ask_price",
      lastMessageAt: HOJE,
      createdAt: HOJE,
    });

    const { getOpportunities } = await import("@/lib/dashboard");
    const oportunidades = await getOpportunities(EST);
    expect(oportunidades.some((o) => o.type === "price_inquiry_no_booking")).toBe(true);
  });
});

describe("pedido demo não alcança operação, pagamento ou notificação", () => {
  it("transitionOrder recusa pedido demo", async () => {
    const { transitionOrder } = await import("@/lib/orders");
    fakeDb.col(`establishments/${EST}/orders`).set("order-demo", {
      id: "order-demo",
      establishmentId: EST,
      conversationId: "5511900000001",
      contactPhone: "5511900000001",
      status: "confirmed",
      version: 2,
      mode: "demo",
      prospectingLeadId: "lead-a",
      items: [],
      fulfillment: "pickup",
    });
    await expect(transitionOrder(EST, "order-demo", "accepted", 2)).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("createPaymentForOrder recusa pedido demo", async () => {
    const { createPaymentForOrder } = await import("@/lib/payments");
    fakeDb.col(`establishments/${EST}/orders`).set("order-demo", {
      id: "order-demo",
      establishmentId: EST,
      status: "confirmed",
      version: 2,
      mode: "demo",
      prospectingLeadId: "lead-a",
      totalCents: 1000,
      items: [],
    });
    await expect(createPaymentForOrder(EST, "order-demo")).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("a fila operacional do painel não lista pedido demo", async () => {
    const { listOrders } = await import("@/lib/orders");
    for (const status of ["confirmed", "accepted", "preparing"]) {
      fakeDb.col(`establishments/${EST}/orders`).set(`order-${status}`, {
        id: `order-${status}`,
        establishmentId: EST,
        status,
        version: 1,
        mode: "demo",
        prospectingLeadId: "lead-a",
        items: [],
        createdAt: HOJE,
        updatedAt: HOJE,
      });
    }
    expect(await listOrders(EST)).toEqual([]);
  });
});
