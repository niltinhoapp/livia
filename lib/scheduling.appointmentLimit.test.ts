// Fix #3 da auditoria de 03/09: listAppointments era a única query do
// sistema sem NENHUM limite. getOpportunities a chamava numa janela de 90
// dias pra frente — sem teto, escala com o volume real de agendamentos do
// tenant, ao contrário de toda outra query de janela larga do sistema
// (30 dias / limit 300 ou 200).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { createAppointment, listAppointments } from "@/lib/scheduling";

const EST = "demo";
const BASE = new Date("2026-09-10T12:00:00.000Z").getTime();

beforeEach(() => {
  fakeDb.reset?.();
});

describe("listAppointments tem limite defensivo", () => {
  it("um limite explícito baixo é respeitado", async () => {
    for (let i = 0; i < 5; i++) {
      await createAppointment(EST, {
        contactPhone: `551499900000${i}`,
        contactName: null,
        serviceName: "Avaliação",
        startAt: BASE + i * 3600000,
        durationMin: 30,
        source: "bot",
      });
    }

    const result = await listAppointments(EST, BASE, BASE + 24 * 3600000, 2);
    expect(result).toHaveLength(2);
  });

  it("o corte mantém os agendamentos mais PRÓXIMOS (ordenação por startAt preservada)", async () => {
    const horarios = [BASE, BASE + 3600000, BASE + 2 * 3600000, BASE + 3 * 3600000];
    for (const [i, startAt] of horarios.entries()) {
      await createAppointment(EST, {
        contactPhone: `551499900000${i}`,
        contactName: null,
        serviceName: "Avaliação",
        startAt,
        durationMin: 30,
        source: "bot",
      });
    }

    const result = await listAppointments(EST, BASE, BASE + 24 * 3600000, 2);
    expect(result.map((a) => a.startAt)).toEqual([horarios[0], horarios[1]]);
  });

  it("o intervalo [from, to) continua correto — nada fora dele entra", async () => {
    await createAppointment(EST, {
      contactPhone: "5514999000001",
      contactName: null,
      serviceName: "Antes",
      startAt: BASE - 3600000,
      durationMin: 30,
      source: "bot",
    });
    await createAppointment(EST, {
      contactPhone: "5514999000002",
      contactName: null,
      serviceName: "Dentro",
      startAt: BASE,
      durationMin: 30,
      source: "bot",
    });
    await createAppointment(EST, {
      contactPhone: "5514999000003",
      contactName: null,
      serviceName: "Depois",
      startAt: BASE + 24 * 3600000,
      durationMin: 30,
      source: "bot",
    });

    const result = await listAppointments(EST, BASE, BASE + 24 * 3600000);
    expect(result.map((a) => a.serviceName)).toEqual(["Dentro"]);
  });

  it("sem passar limitCount, comportamento de sempre é preservado pra uma janela estreita (conflito de horário)", async () => {
    await createAppointment(EST, {
      contactPhone: "5514999000001",
      contactName: null,
      serviceName: "Avaliação",
      startAt: BASE,
      durationMin: 30,
      source: "bot",
    });

    // Mesma forma de chamada usada por hasScheduleConflict/assertBookable:
    // janela de poucos dias, sem limitCount explícito.
    const result = await listAppointments(EST, BASE - 24 * 3600000, BASE + 48 * 3600000);
    expect(result).toHaveLength(1);
  });

  it("não afeta quantidades abaixo do limite default (1000) — não é uma mudança de comportamento pra volume normal", async () => {
    for (let i = 0; i < 10; i++) {
      await createAppointment(EST, {
        contactPhone: `551499900${String(i).padStart(3, "0")}`,
        contactName: null,
        serviceName: "Avaliação",
        startAt: BASE + i * 3600000,
        durationMin: 30,
        source: "bot",
      });
    }

    const result = await listAppointments(EST, BASE, BASE + 24 * 3600000);
    expect(result).toHaveLength(10);
  });
});
