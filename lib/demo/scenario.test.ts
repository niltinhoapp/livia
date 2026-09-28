// F2 — baseline fictício: materialização, normalização e privacidade.
//
// O contrato central provado aqui: este módulo produz DADOS, nunca decisões.
// Quem decide disponibilidade continua sendo o motor real
// (slotBookability/computeSlots), exercitado sobre a ocupação fictícia.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { computeSlots, defaultScheduleConfig, localToEpoch, slotBookability } from "@/lib/scheduling";
import {
  DEFAULT_DEMO_SESSION_TTL_MS,
  DEMO_BASELINE_CONTACT,
  defaultDemoScenario,
  demoScenarioSlotsForDate,
  isDemoBaselineAppointment,
  materializeDemoBaseline,
  normalizeDemoScenario,
} from "./scenario";

const EST = "est-demo";
const OFFSET = -180;
const SEGUNDA = "2026-10-05";
const DOMINGO = "2026-10-04";
const SABADO = "2026-10-03";
const config = { ...defaultScheduleConfig(EST), leadHours: 0 };
// Bem antes do dia testado: leadHours nunca interfere.
const NOW = localToEpoch(SEGUNDA, 0, OFFSET) - 48 * 3600000;

const scenario = defaultDemoScenario(EST);
const baselineFor = (date: string) => materializeDemoBaseline(scenario, date, OFFSET);
const times = (date: string, extra: ReturnType<typeof baselineFor> = []) =>
  computeSlots(config, date, 30, [...baselineFor(date), ...extra], NOW).map((s) => s.time);

describe("cenário default", () => {
  it("declara ocupação em dia útil e no sábado, e nada no domingo", () => {
    expect(demoScenarioSlotsForDate(scenario, SEGUNDA).length).toBeGreaterThan(0);
    expect(demoScenarioSlotsForDate(scenario, SABADO).length).toBeGreaterThan(0);
    expect(demoScenarioSlotsForDate(scenario, DOMINGO)).toEqual([]);
  });

  it("nunca abre um dia que a ScheduleConfig mantém fechado", () => {
    // Domingo é fechado no expediente canônico: mesmo se houvesse ocupação
    // declarada, o motor continua devolvendo zero slot.
    expect(times(DOMINGO)).toEqual([]);
  });

  it("deixa horário livre de propósito — a demo precisa ter o que reservar", () => {
    const livres = times(SEGUNDA);
    expect(livres.length).toBeGreaterThan(0);
    expect(livres).toContain("10:00");
    expect(livres).toContain("14:00");
  });

  it("os horários declarados como ocupados NÃO aparecem como livres", () => {
    const livres = times(SEGUNDA);
    for (const slot of demoScenarioSlotsForDate(scenario, SEGUNDA)) {
      expect(livres).not.toContain(slot.time);
    }
  });

  it("traz TTL de sessão default", () => {
    expect(scenario.sessionTtlMs).toBe(DEFAULT_DEMO_SESSION_TTL_MS);
  });
});

describe("materialização", () => {
  it("produz Appointment ativo, marcado como demo e como baseline", () => {
    const [primeiro] = baselineFor(SEGUNDA);
    expect(primeiro).toBeDefined();
    expect(primeiro!.mode).toBe("demo");
    expect(primeiro!.demoBaseline).toBe(true);
    expect(isDemoBaselineAppointment(primeiro!)).toBe(true);
    expect(primeiro!.status).toBe("confirmed");
  });

  it("não pertence a nenhum lead — é comum a toda a demonstração", () => {
    for (const a of baselineFor(SEGUNDA)) expect(a.prospectingLeadId).toBeNull();
  });

  it("ids são determinísticos: duas materializações do mesmo dia são iguais", () => {
    expect(baselineFor(SEGUNDA).map((a) => a.id)).toEqual(baselineFor(SEGUNDA).map((a) => a.id));
  });

  it("converte a hora local para o instante correto no fuso do estabelecimento", () => {
    const slot = demoScenarioSlotsForDate(scenario, SEGUNDA)[0]!;
    const [hora, minuto] = slot.time.split(":").map(Number);
    const esperado = localToEpoch(SEGUNDA, hora! * 60 + minuto!, OFFSET);
    expect(baselineFor(SEGUNDA).find((a) => a.startAt === esperado)).toBeDefined();
  });

  it("vale para QUALQUER data — não depende de seed por dia", () => {
    for (const date of ["2027-03-15", "2030-11-11", "2026-12-28"]) {
      expect(materializeDemoBaseline(scenario, date, OFFSET).length).toBeGreaterThan(0);
    }
  });
});

describe("privacidade do baseline", () => {
  it("nunca carrega nome de contato", () => {
    for (const a of baselineFor(SEGUNDA)) expect(a.contactName).toBeNull();
  });

  it("o contato é um marcador constante, não um telefone", () => {
    for (const a of baselineFor(SEGUNDA)) {
      expect(a.contactPhone).toBe(DEMO_BASELINE_CONTACT);
      expect(/\d/.test(a.contactPhone)).toBe(false);
    }
  });

  it("o único texto exposto é um nome de serviço fictício do cenário", () => {
    const permitidos = new Set(demoScenarioSlotsForDate(scenario, SEGUNDA).map((s) => s.serviceName));
    for (const a of baselineFor(SEGUNDA)) expect(permitidos.has(a.serviceName)).toBe(true);
  });
});

describe("o motor real decide — o baseline só fornece ocupação", () => {
  it("slotBookability recusa por overlap sobre ocupação fictícia", () => {
    const slot = demoScenarioSlotsForDate(scenario, SEGUNDA)[0]!;
    const [hora, minuto] = slot.time.split(":").map(Number);
    const startAt = localToEpoch(SEGUNDA, hora! * 60 + minuto!, OFFSET);
    expect(slotBookability(config, startAt, 30, baselineFor(SEGUNDA), NOW)).toBe("overlap");
  });

  it("as demais razões continuam vindo do motor, não do cenário", () => {
    // Domingo fechado: a razão é closed_day, mesmo sem ocupação declarada.
    expect(slotBookability(config, localToEpoch(DOMINGO, 10 * 60, OFFSET), 30, baselineFor(DOMINGO), NOW)).toBe("closed_day");
    // Pausa de almoço continua valendo.
    expect(slotBookability(config, localToEpoch(SEGUNDA, 12 * 60, OFFSET), 30, baselineFor(SEGUNDA), NOW)).toBe("during_break");
  });

  it("um horário livre no cenário é reservável pelo motor", () => {
    expect(slotBookability(config, localToEpoch(SEGUNDA, 10 * 60, OFFSET), 30, baselineFor(SEGUNDA), NOW)).toBeNull();
  });
});

describe("normalização — cenário corrompido nunca inventa ocupação", () => {
  it("documento ausente/inválido cai no default", () => {
    expect(normalizeDemoScenario(EST, null).weekly).toEqual(scenario.weekly);
    expect(normalizeDemoScenario(EST, "texto").weekly).toEqual(scenario.weekly);
    expect(normalizeDemoScenario(EST, { weekly: "nao-e-objeto" }).weekly).toEqual(scenario.weekly);
  });

  it("slot malformado é descartado, não interpretado", () => {
    const normalizado = normalizeDemoScenario(EST, {
      weekly: {
        "1": [
          { time: "25:00", serviceName: "Inválido", durationMin: 30 },
          { time: "10:00", serviceName: "", durationMin: 30 },
          { time: "10:00", serviceName: "Válido", durationMin: 0 },
          { time: "10:00", serviceName: "Válido", durationMin: 30 },
        ],
      },
    });
    expect(normalizado.weekly["1"]).toEqual([{ time: "10:00", serviceName: "Válido", durationMin: 30 }]);
  });

  it("dia ausente vira dia sem ocupação, nunca ocupação herdada", () => {
    const normalizado = normalizeDemoScenario(EST, { weekly: { "1": [] } });
    for (const weekday of ["0", "2", "3", "4", "5", "6"]) expect(normalizado.weekly[weekday]).toEqual([]);
  });

  it("TTL inválido cai no default", () => {
    expect(normalizeDemoScenario(EST, { weekly: {}, sessionTtlMs: -1 }).sessionTtlMs).toBe(DEFAULT_DEMO_SESSION_TTL_MS);
    expect(normalizeDemoScenario(EST, { weekly: {}, sessionTtlMs: Number.NaN }).sessionTtlMs).toBe(DEFAULT_DEMO_SESSION_TTL_MS);
  });

  it("cenário customizado válido é preservado", () => {
    const custom = normalizeDemoScenario(EST, {
      weekly: { "1": [{ time: "16:00", serviceName: "Sobrancelha", durationMin: 30 }] },
      sessionTtlMs: 3600000,
    });
    expect(custom.weekly["1"]).toEqual([{ time: "16:00", serviceName: "Sobrancelha", durationMin: 30 }]);
    expect(custom.sessionTtlMs).toBe(3600000);
    expect(times(SEGUNDA, materializeDemoBaseline(custom, SEGUNDA, OFFSET))).not.toContain("16:00");
  });
});
