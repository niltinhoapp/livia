// Regressão do bug real de Production em 03/09/2026.
//
// Existia um Appointment real (5514996447132, "Avaliação", 03/09 09:00,
// status pending) e a Livia respondeu que NÃO tinha conseguido agendar,
// ofereceu outros horários, e depois disse que o agendamento era "amanhã,
// 04/09". Causa: nenhuma ferramenta permitia LER os agendamentos do cliente
// — a única leitura de agenda exposta era find_available_appointments, que
// devolve horários livres.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Appointment, Establishment, ScheduleConfig } from "@/types";

const OFFSET = -180; // America/Sao_Paulo
// 03/09/2026 09:00 local = 12:00 UTC
const HOJE_09H = new Date("2026-09-03T12:00:00.000Z").getTime();
const AMANHA_09H = HOJE_09H + 24 * 3600000;
// "Agora" nos testes: 03/09 14:00 local (depois das 09:00, pra provar que um
// agendamento que já passou HOJE continua sendo encontrado).
const AGORA = new Date("2026-09-03T17:00:00.000Z").getTime();

const listActiveCustomerAppointments = vi.fn();
const findNextAppointment = vi.fn();
const getAppointment = vi.fn();
const setStatus = vi.fn();

vi.mock("@/lib/scheduling", () => ({
  listActiveCustomerAppointments: (...a: unknown[]) => listActiveCustomerAppointments(...a),
  listCustomerAppointments: vi.fn(async () => []),
  findNextAppointment: (...a: unknown[]) => findNextAppointment(...a),
  getAppointment: (...a: unknown[]) => getAppointment(...a),
  setStatus: (...a: unknown[]) => setStatus(...a),
  getScheduleConfig: async (): Promise<ScheduleConfig> => config,
  listAppointments: vi.fn(async () => []),
  computeSlots: vi.fn(() => []),
  createAppointment: vi.fn(),
  localToEpoch: vi.fn(() => 0),
  hasScheduleConflict: vi.fn(async () => false),
  updateAppointment: vi.fn(),
  weekdayOf: vi.fn(() => 4),
}));

vi.mock("@/lib/repo", () => ({
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(),
}));

vi.mock("@/lib/whatsapp/client", () => ({
  normalizePhone: (raw: string) => raw.replace(/\D/g, ""),
}));

const { runTool, relativeDayLabel, startOfLocalDay } = await import("./tools");
type ToolCtx = Parameters<typeof runTool>[2];

const config = { utcOffsetMinutes: OFFSET, defaultDurationMin: 30, days: {} } as unknown as ScheduleConfig;

const est = { id: "demo", bot: { bookingEnabled: true } } as unknown as Establishment;

const ctx: ToolCtx = {
  est,
  kb: null,
  config,
  contactPhone: "5514996447132",
  contactName: "Cliente",
  offset: OFFSET,
  customerProfile: null,
};

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-hoje",
    establishmentId: "demo",
    contactPhone: "5514996447132",
    contactName: "Cliente",
    serviceName: "Avaliação",
    startAt: HOJE_09H,
    durationMin: 30,
    status: "pending",
    source: "bot",
    note: null,
    createdAt: HOJE_09H - 3600000,
    confirmedAt: null,
    reminderSentAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
});

describe("get_customer_appointments — a agenda é a fonte de verdade", () => {
  it("(1) 'tenho consulta hoje?' devolve o Appointment real de hoje às 09:00", async () => {
    listActiveCustomerAppointments.mockResolvedValue([appointment()]);

    const result = await runTool("get_customer_appointments", {}, ctx);

    expect(result.ok).toBe(true);
    const data = result.data as { appointments: Record<string, unknown>[] };
    expect(data.appointments).toHaveLength(1);
    expect(data.appointments[0]).toMatchObject({
      id: "appt-hoje",
      serviceName: "Avaliação",
      date: "03/09/2026",
      time: "09:00",
      day: "hoje",
      status: "pending",
    });
  });

  it("busca a partir do INÍCIO do dia local — um horário das 09:00 ainda aparece às 14:00", async () => {
    listActiveCustomerAppointments.mockResolvedValue([appointment()]);
    await runTool("get_customer_appointments", {}, ctx);

    const [, , from] = listActiveCustomerAppointments.mock.calls[0] as [string, string, number];
    expect(from).toBe(startOfLocalDay(AGORA, OFFSET));
    expect(from).toBeLessThan(HOJE_09H);
  });

  it("(2) status pending é reportado como reservado aguardando confirmação — nunca como confirmado nem inexistente", async () => {
    listActiveCustomerAppointments.mockResolvedValue([appointment({ status: "pending" })]);

    const result = await runTool("get_customer_appointments", {}, ctx);
    const data = result.data as { appointments: { status: string; statusMeaning: string }[] };

    expect(data.appointments[0]!.status).toBe("pending");
    expect(data.appointments[0]!.statusMeaning).toMatch(/reservado/i);
    expect(data.appointments[0]!.statusMeaning).not.toMatch(/confirmada/i);
  });

  it("(3) 'qual horário marquei?' devolve dados estruturados da fonte de verdade", async () => {
    listActiveCustomerAppointments.mockResolvedValue([appointment()]);
    const result = await runTool("get_customer_appointments", {}, ctx);
    const data = result.data as { appointments: Record<string, unknown>[] };

    for (const campo of ["id", "serviceName", "date", "time", "day", "status", "source"]) {
      expect(data.appointments[0]).toHaveProperty(campo);
    }
  });

  it("(4) agendamento de hoje e de amanhã não são confundidos", async () => {
    listActiveCustomerAppointments.mockResolvedValue([
      appointment({ id: "hoje", startAt: HOJE_09H }),
      appointment({ id: "amanha", startAt: AMANHA_09H }),
    ]);

    const result = await runTool("get_customer_appointments", {}, ctx);
    const data = result.data as { appointments: { id: string; day: string; date: string }[] };

    expect(data.appointments.find((a) => a.id === "hoje")).toMatchObject({ day: "hoje", date: "03/09/2026" });
    expect(data.appointments.find((a) => a.id === "amanha")).toMatchObject({ day: "amanhã", date: "04/09/2026" });
  });

  it("(6) sem agendamento: devolve lista vazia e uma nota — nunca inventa horário", async () => {
    listActiveCustomerAppointments.mockResolvedValue([]);

    const result = await runTool("get_customer_appointments", {}, ctx);
    const data = result.data as { appointments: unknown[]; note?: string };

    expect(result.ok).toBe(true);
    expect(data.appointments).toEqual([]);
    expect(data.note).toMatch(/não tem nenhum agendamento/i);
  });

  it("cancelados e faltas não são apresentados como agendamento ativo", async () => {
    // O filtro de status desceu para lib/scheduling.ts
    // (listActiveCustomerAppointments): mantê-lo aqui, DEPOIS do limit da
    // query, era o bug — N cancelados consumiam o limite e escondiam um
    // agendamento ativo. Aqui provamos que a ferramenta usa a leitura que
    // garante o filtro; que ela filtra de fato está em
    // lib/scheduling.appointmentLookup.test.ts.
    listActiveCustomerAppointments.mockResolvedValue([]);

    const result = await runTool("get_customer_appointments", {}, ctx);
    const data = result.data as { appointments: unknown[] };

    expect(listActiveCustomerAppointments).toHaveBeenCalledTimes(1);
    expect(data.appointments).toEqual([]);
  });
});

describe("confirm_appointment — pending → confirmed só via backend", () => {
  it("(5) confirma presença chamando setStatus e reportando sucesso", async () => {
    findNextAppointment.mockResolvedValue(appointment({ status: "pending" }));

    const result = await runTool("confirm_appointment", {}, ctx);

    expect(setStatus).toHaveBeenCalledWith("demo", "appt-hoje", "confirmed");
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ confirmed: true, day: "hoje" });
  });

  it("(5) sem agendamento para confirmar: falha explícita e NENHUMA mudança de status", async () => {
    findNextAppointment.mockResolvedValue(null);

    const result = await runTool("confirm_appointment", {}, ctx);

    expect(result.ok).toBe(false);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("nunca confirma agendamento de outro contato, mesmo com id explícito", async () => {
    getAppointment.mockResolvedValue(appointment({ contactPhone: "5511999998888" }));

    const result = await runTool("confirm_appointment", { appointmentId: "appt-hoje" }, ctx);

    expect(result.ok).toBe(false);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("já confirmado não vira erro nem reconfirma", async () => {
    findNextAppointment.mockResolvedValue(appointment({ status: "confirmed" }));

    const result = await runTool("confirm_appointment", {}, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ alreadyConfirmed: true });
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("datas relativas resolvidas no backend", () => {
  it("compara por dia de calendário local, não por diferença de horas", () => {
    // 23:30 de hoje e 00:30 de amanhã distam 1h, mas são dias diferentes.
    const hoje2330 = new Date("2026-09-04T02:30:00.000Z").getTime(); // 03/09 23:30 local
    const amanha0030 = new Date("2026-09-04T03:30:00.000Z").getTime(); // 04/09 00:30 local
    expect(relativeDayLabel(hoje2330, OFFSET, AGORA)).toBe("hoje");
    expect(relativeDayLabel(amanha0030, OFFSET, AGORA)).toBe("amanhã");
  });

  it("datas distantes viram data concreta, nunca 'amanhã'", () => {
    expect(relativeDayLabel(HOJE_09H + 5 * 24 * 3600000, OFFSET, AGORA)).toBe("08/09/2026");
  });
});
