import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { getAppointment, localToEpoch, defaultScheduleConfig } from "@/lib/scheduling";
import { runTool } from "./tools";

const EST = "demo-est";
const PHONE = "5511999999999";
const start = localToEpoch("2030-01-07", 10 * 60, -180);
const moved = localToEpoch("2030-01-07", 11 * 60, -180);
const est = { id: EST, bot: { bookingEnabled: true, ordersEnabled: false } } as any;
const config = { ...defaultScheduleConfig(EST), leadHours: 0 };
const prospect = { status: "INTERESTED", leadId: "lead-a" } as any;
const context = (lead = "lead-a", prospecting = true) => ({
  est, kb: { services: [] }, config, contactPhone: PHONE, contactName: "Demo", offset: -180,
  customerProfile: null, discussedDate: "2030-01-07",
  ...(prospecting ? { prospectingContext: prospect, demoAuthorization: { authorized: true as const, establishmentId: EST, prospectingLeadId: lead } } : {}),
} as any);

describe("agenda demo autorizada", () => {
  beforeEach(() => { fakeDb.reset(); });

  it("cria, remarca e cancela somente o agendamento demo do mesmo lead", async () => {
    const created = await runTool("create_appointment", { serviceName: "Demonstração", startAt: start }, context());
    expect(created).toMatchObject({ ok: true });
    const list = await runTool("get_customer_appointments", {}, context());
    const id = (list.data as any).appointments[0].id;
    expect(await getAppointment(EST, id)).toMatchObject({ mode: "demo", prospectingLeadId: "lead-a" });

    expect(await runTool("reschedule_appointment", { appointmentId: id, newStartAt: moved }, context())).toMatchObject({ ok: true });
    expect(await getAppointment(EST, id)).toMatchObject({ startAt: moved, mode: "demo", prospectingLeadId: "lead-a" });
    expect(await runTool("cancel_appointment", { appointmentId: id }, context())).toMatchObject({ ok: true });
    expect(await getAppointment(EST, id)).toMatchObject({ status: "cancelled" });
  });

  it("outro lead não assume agendamento demo e Prospect não altera comercial", async () => {
    const created = await runTool("create_appointment", { serviceName: "Demonstração", startAt: start }, context());
    const id = ((await runTool("get_customer_appointments", {}, context())).data as any).appointments[0].id;
    expect(created.ok).toBe(true);
    expect(await runTool("cancel_appointment", { appointmentId: id }, context("lead-b"))).toMatchObject({ ok: false });

    const commercial = await runTool("create_appointment", { serviceName: "Comercial", startAt: moved }, context("", false));
    expect(commercial).toMatchObject({ ok: true });
    const commercialId = ((await runTool("get_customer_appointments", {}, context("", false))).data as any).appointments[0].id;
    expect(await runTool("cancel_appointment", { appointmentId: commercialId }, context())).toMatchObject({ ok: false });
  });
});
