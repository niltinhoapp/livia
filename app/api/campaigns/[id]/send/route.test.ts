import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveEstablishmentId = vi.fn();
const getEstablishment = vi.fn();
const getCampaign = vi.fn();
const activateCampaign = vi.fn();
const dispatchCampaignBatch = vi.fn();
const listMessageTemplates = vi.fn();

vi.mock("@/lib/auth/session", () => ({ resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args) }));
vi.mock("@/lib/repo", () => ({
  getEstablishment: (...args: unknown[]) => getEstablishment(...args),
  getCampaign: (...args: unknown[]) => getCampaign(...args),
  activateCampaign: (...args: unknown[]) => activateCampaign(...args),
}));
vi.mock("@/lib/campaignDispatcher", () => ({ dispatchCampaignBatch: (...args: unknown[]) => dispatchCampaignBatch(...args) }));
vi.mock("@/lib/whatsapp/client", () => ({
  listMessageTemplates: (...args: unknown[]) => listMessageTemplates(...args),
  WhatsAppTemplateError: class WhatsAppTemplateError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } },
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
    const campaign = { id: "c1", status: "running", template: { id: "tpl-1", name: "hello", languageCode: "pt_BR" } };
    getCampaign.mockResolvedValue(campaign);
    activateCampaign.mockResolvedValue({ kind: "activated", campaign });
    listMessageTemplates.mockResolvedValue([{ id: "tpl-1", name: "hello", language: "pt_BR", components: [], approved: true, senderCompatible: true }]);
    dispatchCampaignBatch.mockResolvedValue({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
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

  it("ativa campanha válida e delega somente um lote limitado ao dispatcher", async () => {
    const response = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(200);
    expect(activateCampaign).toHaveBeenCalledWith("est-a", "c1", {
      mode: "now",
      scheduledAt: null,
      maxRecipients: 200,
    });
    expect(dispatchCampaignBatch).toHaveBeenCalledWith("est-a", "c1", { batchSize: 200 });
  });

  it("limita campanha de conta em trial a 100 destinatários", async () => {
    getEstablishment.mockResolvedValue({
      id: "est-a",
      whatsapp: { status: "connected" },
      billing: { billingStatus: "trial", trialEndsAt: Date.now() + 60_000, updatedAt: Date.now() },
    });
    const response = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(200);
    expect(activateCampaign).toHaveBeenCalledWith("est-a", "c1", {
      mode: "now",
      scheduledAt: null,
      maxRecipients: 100,
    });
    expect(dispatchCampaignBatch).toHaveBeenCalledWith("est-a", "c1", { batchSize: 100 });
  });

  it("retry/double click retorna ativação idempotente", async () => {
    activateCampaign.mockResolvedValue({ kind: "already_activated", campaign: { id: "c1", status: "running" } });
    const first = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    const second = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).idempotent).toBe(true);
    expect(dispatchCampaignBatch).toHaveBeenCalledTimes(2);
  });

  it("não ativa sem WhatsApp conectado", async () => {
    getEstablishment.mockResolvedValue({ id: "est-a", whatsapp: { status: "disconnected" } });
    const response = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(409);
    expect(activateCampaign).not.toHaveBeenCalled();
  });

  it("não ativa nem delega ao dispatcher se a revalidação Meta não aprovar o template", async () => {
    listMessageTemplates.mockResolvedValue([{ id: "tpl-1", name: "hello", language: "pt_BR", components: [], approved: false, senderCompatible: true }]);
    const response = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(409);
    expect(activateCampaign).not.toHaveBeenCalled();
    expect(dispatchCampaignBatch).not.toHaveBeenCalled();
  });

  it("bloqueia template parametrizado sem configuração das variáveis", async () => {
    listMessageTemplates.mockResolvedValue([{ id: "tpl-1", name: "hello", language: "pt_BR", components: [{ type: "BODY", text: "Olá {{1}}" }], approved: true, senderCompatible: true }]);
    const response = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(409);
    expect(activateCampaign).not.toHaveBeenCalled();
  });

  it("ativa template parametrizado quando todas as variáveis estão configuradas", async () => {
    const campaign = {
      id: "c1",
      status: "running",
      template: {
        id: "tpl-1",
        name: "hello",
        languageCode: "pt_BR",
        parameterBindings: [
          { index: 1, source: "customer_name" },
          { index: 2, source: "fixed", value: "sexta-feira" },
        ],
      },
    };
    getCampaign.mockResolvedValue(campaign);
    activateCampaign.mockResolvedValue({ kind: "activated", campaign });
    listMessageTemplates.mockResolvedValue([{
      id: "tpl-1",
      name: "hello",
      language: "pt_BR",
      components: [{ type: "BODY", text: "Olá {{1}}, esperamos você {{2}}" }],
      approved: true,
      senderCompatible: true,
    }]);

    const response = await POST(req({ confirm: true }), { params: Promise.resolve({ id: "c1" }) });

    expect(response.status).toBe(200);
    expect(activateCampaign).toHaveBeenCalled();
  });

  it("encaminha agendamento futuro sem loop de envio", async () => {
    const future = Date.now() + 60_000;
    activateCampaign.mockResolvedValue({ kind: "activated", campaign: { id: "c1", status: "scheduled" } });
    await POST(req({ confirm: true, scheduledAt: future }), { params: Promise.resolve({ id: "c1" }) });
    expect(activateCampaign).toHaveBeenCalledWith("est-a", "c1", {
      mode: "scheduled",
      scheduledAt: future,
      maxRecipients: 200,
    });
  });
});
