import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  AppointmentConflictError,
  bookAppointment,
  defaultScheduleConfig,
  listAppointments,
  rescheduleBookedAppointment,
  setStatus,
} from "@/lib/scheduling";

const START = Date.UTC(2030, 0, 7, 12, 0);
const config = { ...defaultScheduleConfig("est-a"), leadHours: 0 };

function input(startAt = START, durationMin = 60, contactPhone = "5511999999999") {
  return { contactPhone, contactName: "Cliente", serviceName: "Consulta", startAt, durationMin, source: "bot" as const };
}

beforeEach(() => fakeDb.reset());

describe("ocupação transacional da agenda", () => {
  it("duas criações simultâneas no mesmo slot deixam exatamente uma vencedora", async () => {
    const results = await Promise.allSettled([bookAppointment("est-a", config, input()), bookAppointment("est-a", config, input(START, 60, "5511888888888"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toBeInstanceOf(AppointmentConflictError);
  });

  it("detecta horários parcialmente sobrepostos", async () => {
    await bookAppointment("est-a", config, input());
    await expect(bookAppointment("est-a", config, input(START + 30 * 60000, 60))).rejects.toMatchObject({ reason: "overlap" });
  });

  it("isola a ocupação por estabelecimento", async () => {
    await Promise.all([bookAppointment("est-a", config, input()), bookAppointment("est-b", { ...config, establishmentId: "est-b" }, input())]);
    expect(await listAppointments("est-a", START - 1, START + 1)).toHaveLength(1);
    expect(await listAppointments("est-b", START - 1, START + 1)).toHaveLength(1);
  });

  it("criação concorrendo com remarcação deixa exatamente uma ocupar o alvo", async () => {
    const existing = await bookAppointment("est-a", config, input(START + 2 * 3600000));
    const results = await Promise.allSettled([
      bookAppointment("est-a", config, input()),
      rescheduleBookedAppointment("est-a", config, existing.id, START, 60),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("duas remarcações disputando o mesmo horário deixam exatamente uma vencedora", async () => {
    const [first, second] = await Promise.all([
      bookAppointment("est-a", config, input(START + 2 * 3600000)),
      bookAppointment("est-a", config, input(START + 4 * 3600000, 60, "5511777777777")),
    ]);
    const results = await Promise.allSettled([
      rescheduleBookedAppointment("est-a", config, first.id, START, 60),
      rescheduleBookedAppointment("est-a", config, second.id, START, 60),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("falha na remarcação preserva o agendamento original e cancelamento libera o slot", async () => {
    const original = await bookAppointment("est-a", config, input());
    await bookAppointment("est-a", config, input(START + 2 * 3600000, 60, "5511777777777"));
    await expect(rescheduleBookedAppointment("est-a", config, original.id, START + 2 * 3600000, 60)).rejects.toMatchObject({ reason: "overlap" });
    expect((await listAppointments("est-a", START - 1, START + 1))[0]?.id).toBe(original.id);
    await setStatus("est-a", original.id, "cancelled");
    await expect(bookAppointment("est-a", config, input())).resolves.toMatchObject({ startAt: START });
  });
});
