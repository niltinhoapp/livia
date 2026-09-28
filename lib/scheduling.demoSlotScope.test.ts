// F0.2 — escopo de disputa de slot entre demonstração e agenda real.
//
// `mode: "demo"` era só um rótulo: o registro entrava no MESMO cálculo de
// disponibilidade/conflito da agenda real. Isto provava duas falhas:
//
//   1. demos de leads diferentes acumulavam ocupação até a agenda de
//      demonstração ficar sem horário livre;
//   2. um registro de demonstração podia bloquear cliente REAL.
//
// A correção é de escopo de LEITURA. Estes testes fixam as duas direções e,
// sobretudo, provam que o motor (`slotBookability`/`computeSlots`) NÃO mudou:
// produção continua bloqueando produção.
import { describe, it, expect, vi } from "vitest";

// As funções testadas aqui são puras, mas lib/scheduling.ts importa o
// Firestore no topo do módulo — mesmo fake já usado por
// lib/scheduling.bookableSlot.test.ts.
vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import {
  PRODUCTION_SLOTS,
  computeSlots,
  contendingAppointments,
  defaultScheduleConfig,
  demoSlots,
  isDemoAppointment,
  localToEpoch,
  slotAudienceOf,
  slotBookability,
} from "./scheduling";
import type { Appointment } from "@/types";

const EST = "est_demo";
const DATE = "2026-10-05"; // segunda-feira
const config = { ...defaultScheduleConfig(EST), leadHours: 0 };

function appt(over: Partial<Appointment> = {}): Appointment {
  return {
    id: "a1",
    establishmentId: EST,
    contactPhone: "5514991234567",
    contactName: null,
    serviceName: "Avaliação",
    startAt: localToEpoch(DATE, 10 * 60, config.utcOffsetMinutes),
    durationMin: 30,
    status: "pending",
    source: "bot",
    note: null,
    createdAt: 0,
    confirmedAt: null,
    reminderSentAt: null,
    ...over,
  } as Appointment;
}

const demo = (leadId: string, hourMin: number, over: Partial<Appointment> = {}) =>
  appt({
    id: `demo_${leadId}_${hourMin}`,
    mode: "demo",
    prospectingLeadId: leadId,
    startAt: localToEpoch(DATE, hourMin, config.utcOffsetMinutes),
    ...over,
  });

const real = (hourMin: number, over: Partial<Appointment> = {}) =>
  appt({ id: `real_${hourMin}`, startAt: localToEpoch(DATE, hourMin, config.utcOffsetMinutes), ...over });

// "now" fixo bem antes do dia testado: leadHours nunca interfere.
const NOW = localToEpoch(DATE, 0, config.utcOffsetMinutes) - 48 * 3600000;
const times = (list: Appointment[]) => computeSlots(config, DATE, 30, list, NOW).map((s) => s.time);

describe("isDemoAppointment", () => {
  it("ausência de mode é produção (documento legado)", () => {
    const legado = appt();
    delete (legado as { mode?: unknown }).mode;
    expect(isDemoAppointment(legado)).toBe(false);
  });

  it("mode demo é demonstração", () => {
    expect(isDemoAppointment(demo("lead-1", 600))).toBe(true);
  });
});

describe("slotAudienceOf", () => {
  it("agendamento real -> público produção", () => {
    expect(slotAudienceOf(real(600))).toEqual(PRODUCTION_SLOTS);
  });

  it("agendamento demo -> público daquele lead", () => {
    expect(slotAudienceOf(demo("lead-7", 600))).toEqual({ kind: "demo", prospectingLeadId: "lead-7" });
  });

  it("demo sem prospectingLeadId -> lead nulo, não vira produção", () => {
    const orfao = appt({ mode: "demo", prospectingLeadId: null });
    expect(slotAudienceOf(orfao)).toEqual({ kind: "demo", prospectingLeadId: null });
  });
});

describe("contendingAppointments — público PRODUÇÃO", () => {
  it("demo NUNCA disputa slot com cliente real", () => {
    const lista = [real(600), demo("lead-1", 660), demo("lead-2", 720)];
    expect(contendingAppointments(PRODUCTION_SLOTS, lista).map((a) => a.id)).toEqual(["real_600"]);
  });

  it("produção continua disputando com produção (motor inalterado)", () => {
    const lista = [real(600), real(660)];
    expect(contendingAppointments(PRODUCTION_SLOTS, lista)).toHaveLength(2);
  });
});

describe("contendingAppointments — público DEMO", () => {
  it("produção disputa: a demo mostra a agenda REAL, não disponibilidade inventada", () => {
    const lista = [real(600)];
    expect(contendingAppointments(demoSlots("lead-1"), lista).map((a) => a.id)).toEqual(["real_600"]);
  });

  it("o próprio lead disputa consigo mesmo: quem reservou 14h vê 14h ocupado", () => {
    const lista = [demo("lead-1", 840)];
    expect(contendingAppointments(demoSlots("lead-1"), lista).map((a) => a.id)).toEqual(["demo_lead-1_840"]);
  });

  it("demo de OUTRO lead não disputa — é a causa do acúmulo", () => {
    const lista = [demo("lead-2", 600), demo("lead-3", 660)];
    expect(contendingAppointments(demoSlots("lead-1"), lista)).toHaveLength(0);
  });
});

describe("acúmulo da agenda de demonstração (cenário da auditoria)", () => {
  // Expediente default: 09:00-18:00 com pausa 12:00-13:00, slots de 30min.
  const livresNoDiaVazio = times([]);

  it("o dia vazio tem horários livres (baseline)", () => {
    expect(livresNoDiaVazio.length).toBeGreaterThan(0);
    expect(livresNoDiaVazio).toContain("09:00");
  });

  it("ANTES do escopo: demos de outros leads esgotavam o dia", () => {
    // Reproduz o comportamento antigo passando a lista CRUA ao motor.
    const todosOsSlots = livresNoDiaVazio.map((t) => {
      const [h, m] = t.split(":").map(Number);
      return h! * 60 + m!;
    });
    const demosDeOutros = todosOsSlots.map((min, i) => demo(`lead-outro-${i}`, min));
    expect(times(demosDeOutros)).toHaveLength(0); // "não há horários livres nesse dia"
  });

  it("DEPOIS do escopo: o mesmo dia volta a ficar livre para um lead novo", () => {
    const todosOsSlots = livresNoDiaVazio.map((t) => {
      const [h, m] = t.split(":").map(Number);
      return h! * 60 + m!;
    });
    const demosDeOutros = todosOsSlots.map((min, i) => demo(`lead-outro-${i}`, min));
    const escopado = contendingAppointments(demoSlots("lead-novo"), demosDeOutros);
    expect(times(escopado)).toEqual(livresNoDiaVazio);
  });

  it("a demo permanece coerente: o slot que o PRÓPRIO lead reservou sai da lista", () => {
    const meu = demo("lead-novo", 10 * 60); // 10:00
    const escopado = contendingAppointments(demoSlots("lead-novo"), [meu, demo("lead-outro", 11 * 60)]);
    const livres = times(escopado);
    expect(livres).not.toContain("10:00"); // o próprio bloqueia
    expect(livres).toContain("11:00"); // o de outro lead, não
  });

  it("agendamento REAL do tenant continua ocupando o slot na visão da demo", () => {
    const escopado = contendingAppointments(demoSlots("lead-novo"), [real(9 * 60)]);
    expect(times(escopado)).not.toContain("09:00");
  });
});

describe("produção não é afetada por demonstração", () => {
  it("computeSlots para produção ignora demo e mantém os horários livres", () => {
    const todosOsSlots = times([]).map((t) => {
      const [h, m] = t.split(":").map(Number);
      return h! * 60 + m!;
    });
    const demos = todosOsSlots.map((min, i) => demo(`lead-${i}`, min));
    expect(times(contendingAppointments(PRODUCTION_SLOTS, demos))).toEqual(times([]));
  });

  it("slotBookability continua recusando overlap REAL (motor intocado)", () => {
    const startAt = localToEpoch(DATE, 10 * 60, config.utcOffsetMinutes);
    const lista = contendingAppointments(PRODUCTION_SLOTS, [real(10 * 60)]);
    expect(slotBookability(config, startAt, 30, lista, NOW)).toBe("overlap");
  });

  it("slotBookability não recusa por overlap quando o conflito é só demo", () => {
    const startAt = localToEpoch(DATE, 10 * 60, config.utcOffsetMinutes);
    const lista = contendingAppointments(PRODUCTION_SLOTS, [demo("lead-x", 10 * 60)]);
    expect(slotBookability(config, startAt, 30, lista, NOW)).toBeNull();
  });

  it("as demais razões de recusa seguem valendo (closed_day preservado)", () => {
    const domingo = "2026-10-04";
    const startAt = localToEpoch(domingo, 10 * 60, config.utcOffsetMinutes);
    expect(slotBookability(config, startAt, 30, [], NOW)).toBe("closed_day");
  });

  it("cancelado/no_show continuam não disputando, independente do escopo", () => {
    const cancelado = real(10 * 60, { status: "cancelled" });
    const startAt = localToEpoch(DATE, 10 * 60, config.utcOffsetMinutes);
    const lista = contendingAppointments(PRODUCTION_SLOTS, [cancelado]);
    expect(slotBookability(config, startAt, 30, lista, NOW)).toBeNull();
  });
});
