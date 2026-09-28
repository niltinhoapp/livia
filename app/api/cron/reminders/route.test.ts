import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const dbGet = vi.fn();
const getScheduleConfig = vi.fn();
const listAppointments = vi.fn();
const updateAppointment = vi.fn();
const sendTemplate = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({ db: { collection: () => ({ where: () => ({ get: () => dbGet() }) }) } }));
vi.mock("@/lib/scheduling", async () => ({
  getScheduleConfig: (...args: unknown[]) => getScheduleConfig(...args),
  listAppointments: (...args: unknown[]) => listAppointments(...args),
  updateAppointment: (...args: unknown[]) => updateAppointment(...args),
  // Regra sob teste em "F0.1": usa a implementação REAL, não um dublê.
  isDemoAppointment: (await vi.importActual<typeof import("@/lib/scheduling")>("@/lib/scheduling")).isDemoAppointment,
}));
vi.mock("@/lib/whatsapp/client", () => ({ sendTemplate: (...args: unknown[]) => sendTemplate(...args) }));

const { GET } = await import("./route");

function req(headers: Record<string, string> = {}) {
  return new NextRequest("https://example.test/api/cron/reminders", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cr3t";
  dbGet.mockResolvedValue({ docs: [], size: 0 });
});

describe("GET /api/cron/reminders", () => {
  it.each([
    ["ausente", undefined, {}],
    ["vazio", "", {}],
    ["header ausente", "s3cr3t", {}],
    ["Bearer incorreto", "s3cr3t", { authorization: "Bearer incorreto" }],
  ])("rejeita quando CRON_SECRET está %s sem executar operações", async (_label, secret, headers) => {
    if (secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = secret;

    const response = await GET(req(headers));

    expect(response.status).toBe(401);
    expect(dbGet).not.toHaveBeenCalled();
    expect(getScheduleConfig).not.toHaveBeenCalled();
    expect(listAppointments).not.toHaveBeenCalled();
    expect(updateAppointment).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("com Bearer correto executa o job", async () => {
    const response = await GET(req({ authorization: "Bearer s3cr3t" }));

    expect(response.status).toBe(200);
    expect(dbGet).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ establishments: 0, sent: 0 });
  });
});

// ---- F0.1: agendamento de demonstração não pode gerar lembrete real ----
//
// O cron envia um TEMPLATE aprovado da Meta para o telefone do agendamento e
// filtrava apenas por `status`. Um registro `mode: "demo"` nasce "pending" e
// era indistinguível de um agendamento de cliente: o prospect recebia
// mensagem sobre um compromisso que não existe.
describe("GET /api/cron/reminders — escopo demo (F0.1)", () => {
  const AUTH = { authorization: "Bearer s3cr3t" };

  function establishment(id = "est_demo") {
    return {
      id,
      name: "Tenant Demo",
      status: "active",
      whatsapp: { wabaId: "waba", phoneNumberId: "pn_1", status: "connected" },
    };
  }

  function appointment(over: Record<string, unknown> = {}) {
    return {
      id: "appt_real",
      establishmentId: "est_demo",
      contactPhone: "5514991234567",
      contactName: "Cliente Real",
      serviceName: "Avaliação",
      startAt: Date.now() + 6 * 3600000,
      durationMin: 30,
      status: "pending",
      source: "bot",
      reminderSentAt: null,
      ...over,
    };
  }

  const demo = (over: Record<string, unknown> = {}) =>
    appointment({ id: "appt_demo", mode: "demo", prospectingLeadId: "lead-1", ...over });

  function telefonesNotificados(): string[] {
    return sendTemplate.mock.calls.map((call) => String(call[2]));
  }

  beforeEach(() => {
    const est = establishment();
    dbGet.mockResolvedValue({ docs: [{ id: est.id, data: () => est }], size: 1 });
    getScheduleConfig.mockResolvedValue({
      utcOffsetMinutes: -180,
      reminderTemplateName: "lembrete_consulta",
      reminderTemplateLang: "pt_BR",
    });
    sendTemplate.mockResolvedValue({ waMessageId: "wamid.tpl" });
  });

  it("(1) agendamento real elegível continua recebendo lembrete", async () => {
    listAppointments.mockResolvedValue([appointment()]);

    const response = await GET(req(AUTH));
    const body = await response.json();

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(telefonesNotificados()).toEqual(["5514991234567"]);
    expect(body).toMatchObject({ sent: 1, skippedDemo: 0 });
    // O envio é carimbado para não repetir no dia seguinte.
    expect(updateAppointment).toHaveBeenCalledTimes(1);
    expect(updateAppointment.mock.calls[0]![1]).toBe("appt_real");
  });

  it("(2) agendamento demo elegível NÃO recebe lembrete", async () => {
    listAppointments.mockResolvedValue([demo({ contactPhone: "5511988887777" })]);

    const response = await GET(req(AUTH));
    const body = await response.json();

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(body).toMatchObject({ sent: 0, skippedDemo: 1 });
    // Nada é carimbado: o registro demo permanece intocado.
    expect(updateAppointment).not.toHaveBeenCalled();
  });

  it("(3) mistura real + demo: somente o real é processado", async () => {
    listAppointments.mockResolvedValue([
      demo({ id: "d1", prospectingLeadId: "lead-1", contactPhone: "5511900000001" }),
      appointment(),
      demo({ id: "d2", prospectingLeadId: "lead-2", contactPhone: "5511900000002" }),
    ]);

    const response = await GET(req(AUTH));
    const body = await response.json();

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(telefonesNotificados()).toEqual(["5514991234567"]);
    expect(body).toMatchObject({ sent: 1, skippedDemo: 2 });
  });

  it("(4) agendamento legado sem `mode` preserva o comportamento real", async () => {
    const legado = appointment({ id: "appt_legado" });
    delete (legado as { mode?: unknown }).mode;
    listAppointments.mockResolvedValue([legado]);

    const response = await GET(req(AUTH));

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ sent: 1, skippedDemo: 0 });
  });

  it("(5) demo confirmado também é ignorado — o filtro não depende de status", async () => {
    listAppointments.mockResolvedValue([demo({ status: "confirmed" })]);

    const response = await GET(req(AUTH));

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ skippedDemo: 1 });
  });

  it("(6) demo que já tivesse reminderSentAt continua sem reenvio nem efeito", async () => {
    listAppointments.mockResolvedValue([demo({ reminderSentAt: Date.now() - 3600000 })]);

    await GET(req(AUTH));

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(updateAppointment).not.toHaveBeenCalled();
  });
});
