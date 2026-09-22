import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveEstablishmentId = vi.fn();
const getScheduleConfig = vi.fn();
const listAppointments = vi.fn();
const bookAppointment = vi.fn();
const computeSlots = vi.fn();
const logError = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: (...a: unknown[]) => resolveEstablishmentId(...a),
}));
vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: (...a: unknown[]) => getScheduleConfig(...a),
  listAppointments: (...a: unknown[]) => listAppointments(...a),
  bookAppointment: (...a: unknown[]) => bookAppointment(...a),
  AppointmentConflictError: class AppointmentConflictError extends Error {},
  computeSlots: (...a: unknown[]) => computeSlots(...a),
}));
vi.mock("@/lib/observability", () => ({
  logError: (...a: unknown[]) => logError(...a),
}));

const { POST } = await import("./route");

const EST_ID = "est_1";

function request(body: unknown) {
  return new Request("https://livia.test/api/appointments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    contactPhone: "5511999999999",
    serviceName: "Corte",
    startAt: Date.UTC(2026, 9, 1, 10, 0, 0),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveEstablishmentId.mockResolvedValue(EST_ID);
  getScheduleConfig.mockResolvedValue({ defaultDurationMin: 30 });
  listAppointments.mockResolvedValue([]);
  bookAppointment.mockResolvedValue({ id: "appt_1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/appointments — delta OT-READY-02 (observabilidade)", () => {
  it("caminho feliz continua funcionando normalmente (aditivo, sem mudança de comportamento)", async () => {
    const res = await POST(request(validBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ appointment: { id: "appt_1" } });
    expect(logError).not.toHaveBeenCalled();
  });

  it("falha em bookAppointment agora retorna 500 com log estruturado, em vez de exceção não tratada", async () => {
    bookAppointment.mockRejectedValueOnce(new Error("Firestore indisponível"));
    const res = await POST(request(validBody()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ category: "agenda", operation: "create_appointment", establishmentId: EST_ID }),
    );
  });

  it("resposta de erro nao vaza mensagem bruta do erro interno", async () => {
    bookAppointment.mockRejectedValueOnce(new Error("detalhe interno sensível"));
    const res = await POST(request(validBody()));
    const text = await res.text();
    expect(text).not.toContain("detalhe interno sensível");
  });
});
