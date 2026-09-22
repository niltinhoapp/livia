import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const dispatchCampaignBatch = vi.fn();
const listCampaigns = vi.fn();
const dbGet = vi.fn();

vi.mock("@/lib/campaignDispatcher", () => ({
  dispatchCampaignBatch: (...args: unknown[]) => dispatchCampaignBatch(...args),
}));
vi.mock("@/lib/repo", () => ({ listCampaigns: (...args: unknown[]) => listCampaigns(...args) }));
vi.mock("@/lib/firebase/admin", () => ({
  db: {
    collection: () => ({
      where: () => ({ get: () => dbGet() }),
    }),
  },
}));

const { GET } = await import("./route");

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

describe("GET /api/cron/campaigns-dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cr3t";
    process.env.CAMPAIGNS_SEND_ENABLED = "true";
  });

  it("rejeita sem o Bearer CRON_SECRET correto — nunca chama o dispatcher", async () => {
    const response = await GET(req("https://example.test/api/cron/campaigns-dispatch"));
    expect(response.status).toBe(401);
    expect(dispatchCampaignBatch).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
  });

  it("com o secret correto, varre estabelecimentos conectados e despacha campanhas running", async () => {
    dbGet.mockResolvedValue({
      docs: [{ data: () => ({ id: "est-a", whatsapp: { status: "connected" } }) }],
    });
    listCampaigns.mockResolvedValue([
      { id: "c1", status: "running" },
      { id: "c2", status: "draft" }, // não deve ser despachada
    ]);
    dispatchCampaignBatch.mockResolvedValue({ claimed: 3, sent: 2, skipped: 1, failed: 0, retryScheduled: 0 });

    const response = await GET(req("https://example.test/api/cron/campaigns-dispatch", { authorization: "Bearer s3cr3t" }));

    expect(response.status).toBe(200);
    expect(dispatchCampaignBatch).toHaveBeenCalledTimes(1);
    expect(dispatchCampaignBatch).toHaveBeenCalledWith("est-a", "c1", { batchSize: 20 });
    const body = await response.json();
    expect(body.results).toEqual([{ establishmentId: "est-a", campaignId: "c1", claimed: 3, sent: 2, skipped: 1, failed: 0, retryScheduled: 0 }]);
  });

  it("uma campanha falhando não impede as outras de serem processadas", async () => {
    dbGet.mockResolvedValue({
      docs: [{ data: () => ({ id: "est-a", whatsapp: { status: "connected" } }) }],
    });
    listCampaigns.mockResolvedValue([
      { id: "c1", status: "running" },
      { id: "c2", status: "running" },
    ]);
    dispatchCampaignBatch
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ claimed: 1, sent: 1, skipped: 0, failed: 0, retryScheduled: 0 });

    const response = await GET(req("https://example.test/api/cron/campaigns-dispatch", { authorization: "Bearer s3cr3t" }));

    const body = await response.json();
    expect(body.errors).toHaveLength(1);
    expect(body.results).toHaveLength(1);
  });

  it("aceita alvo único via query params (?establishmentId=&campaignId=) sem varrer todos os tenants", async () => {
    dispatchCampaignBatch.mockResolvedValue({ claimed: 1, sent: 1, skipped: 0, failed: 0, retryScheduled: 0 });

    const response = await GET(
      req("https://example.test/api/cron/campaigns-dispatch?establishmentId=est-x&campaignId=camp-x", {
        authorization: "Bearer s3cr3t",
      }),
    );

    expect(response.status).toBe(200);
    expect(dbGet).not.toHaveBeenCalled();
    expect(listCampaigns).not.toHaveBeenCalled();
    expect(dispatchCampaignBatch).toHaveBeenCalledWith("est-x", "camp-x", { batchSize: 20 });
  });

  it("sem CRON_SECRET configurado, falha fechado", async () => {
    delete process.env.CRON_SECRET;
    dbGet.mockResolvedValue({ docs: [] });

    const response = await GET(req("https://example.test/api/cron/campaigns-dispatch"));
    expect(response.status).toBe(401);
    expect(dbGet).not.toHaveBeenCalled();
    expect(dispatchCampaignBatch).not.toHaveBeenCalled();
  });

  it("com CRON_SECRET vazio, falha fechado sem executar operações", async () => {
    process.env.CRON_SECRET = "";

    const response = await GET(req("https://example.test/api/cron/campaigns-dispatch"));

    expect(response.status).toBe(401);
    expect(dbGet).not.toHaveBeenCalled();
    expect(dispatchCampaignBatch).not.toHaveBeenCalled();
  });

  it("rejeita Bearer incorreto sem executar operações", async () => {
    const response = await GET(req("https://example.test/api/cron/campaigns-dispatch", { authorization: "Bearer incorreto" }));

    expect(response.status).toBe(401);
    expect(dbGet).not.toHaveBeenCalled();
    expect(dispatchCampaignBatch).not.toHaveBeenCalled();
  });

  it("kill switch fechado impede qualquer leitura ou dispatcher", async () => {
    process.env.CAMPAIGNS_SEND_ENABLED = "false";
    const response = await GET(req("https://example.test/api/cron/campaigns-dispatch", { authorization: "Bearer s3cr3t" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false, processed: 0 });
    expect(dbGet).not.toHaveBeenCalled();
    expect(dispatchCampaignBatch).not.toHaveBeenCalled();
  });
});
