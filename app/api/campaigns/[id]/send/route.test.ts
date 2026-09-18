import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveEstablishmentId = vi.fn();
const getEstablishment = vi.fn();
const activateCampaign = vi.fn();

vi.mock("@/lib/auth/session", () => ({ resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args) }));
vi.mock("@/lib/repo", () => ({
  getEstablishment: (...args: unknown[]) => getEstablishment(...args),
  activateCampaign: (...args: unknown[]) => activateCampaign(...args),
}));

const { POST } = await import("./route");

function req(body: unknown) {
  return new NextRequest("https://example.test/api/campaigns/c1/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/campaigns/:id/send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CAMPAIGNS_SEND_ENABLED", "true");
    resolveEstablishmentId.mockResolvedValue("est-a");
    getEstablishment.mockResolvedValue({ id: "est-a", whatsapp: { status: "connected" } });
    activateCampaign.mockResolvedValue({ kind: "activated", campaign: { id: "c1", status: "running" } });
  });

  it("isola tenant pela sessão e não aceita confirmação ausente", async () => {
    const response = await POST(req({}), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(400);
    expect(activateCampaign).not.toHaveBeenCalled();
  });

  it("kill switch fechado bloqueia antes de consultar campanha ou sender", async () => {
    vi.stubEnv("CAMPAIGNS_SEND_ENABLED", "false");
    const response = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(503);
    expect(getEstablishment).not.toHaveBeenCalled();
    expect(activateCampaign).not.toHaveBeenCalled();
  });

  it("ativa campanha válida sem enviar dentro da request", async () => {
    const response = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(200);
    expect(activateCampaign).toHaveBeenCalledWith("est-a", "c1", {
      mode: "now",
      scheduledAt: null,
      maxRecipients: 5,
    });
  });

  it("retry/double click retorna ativação idempotente", async () => {
    activateCampaign.mockResolvedValue({ kind: "already_activated", campaign: { id: "c1", status: "running" } });
    const first = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    const second = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).idempotent).toBe(true);
  });

  it("não ativa sem WhatsApp conectado", async () => {
    getEstablishment.mockResolvedValue({ id: "est-a", whatsapp: { status: "disconnected" } });
    const response = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(409);
    expect(activateCampaign).not.toHaveBeenCalled();
  });

  it("encaminha agendamento futuro sem loop de envio", async () => {
    const future = Date.now() + 60_000;
    activateCampaign.mockResolvedValue({ kind: "activated", campaign: { id: "c1", status: "scheduled" } });
    await POST(req({ confirm: true, scheduledAt: future }), { params: Promise.resolve({ id: "c1" }) });
    expect(activateCampaign).toHaveBeenCalledWith("est-a", "c1", {
      mode: "scheduled",
      scheduledAt: future,
      maxRecipients: 5,
    });
  });
});
