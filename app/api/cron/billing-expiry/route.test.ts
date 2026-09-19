import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { TRIAL_GRACE_WINDOW_MS } from "@/lib/billing/trialWindow";

const applyBillingStatusExpiry = vi.fn();
const trialGet = vi.fn();
const pastDueGet = vi.fn();

vi.mock("@/lib/repo", () => ({
  applyBillingStatusExpiry: (...a: unknown[]) => applyBillingStatusExpiry(...a),
}));
vi.mock("@/lib/firebase/admin", () => ({
  db: {
    collection: () => ({
      where: (_field: string, _op: string, value: string) => ({
        get: () => (value === "trial" ? trialGet() : pastDueGet()),
      }),
    }),
  },
}));

const { GET } = await import("./route");

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cr3t";
  trialGet.mockResolvedValue({ docs: [] });
  pastDueGet.mockResolvedValue({ docs: [] });
});

describe("GET /api/cron/billing-expiry", () => {
  it("rejeita sem o Bearer CRON_SECRET correto — nunca consulta nem aplica nada", async () => {
    const response = await GET(req("https://example.test/api/cron/billing-expiry"));
    expect(response.status).toBe(401);
    expect(trialGet).not.toHaveBeenCalled();
    expect(applyBillingStatusExpiry).not.toHaveBeenCalled();
  });

  it("trial vencido HÁ MAIS de 24h (tolerância de regularização esgotada) dispara trial_expired", async () => {
    const now = Date.now();
    trialGet.mockResolvedValue({
      docs: [{ data: () => ({ id: "est-a", billing: { billingStatus: "trial", trialEndsAt: now - TRIAL_GRACE_WINDOW_MS - 1000 } }) }],
    });
    applyBillingStatusExpiry.mockResolvedValue("applied");

    const response = await GET(req("https://example.test/api/cron/billing-expiry", { authorization: "Bearer s3cr3t" }));

    expect(response.status).toBe(200);
    expect(applyBillingStatusExpiry).toHaveBeenCalledWith("est-a", "trial_expired", expect.any(Number));
    const body = await response.json();
    expect(body.results).toEqual([{ establishmentId: "est-a", event: "trial_expired", outcome: "applied" }]);
  });

  it("trial ainda dentro da janela (antes de trialEndsAt) NÃO dispara nada", async () => {
    const now = Date.now();
    trialGet.mockResolvedValue({
      docs: [{ data: () => ({ id: "est-a", billing: { billingStatus: "trial", trialEndsAt: now + 60_000 } }) }],
    });

    const response = await GET(req("https://example.test/api/cron/billing-expiry", { authorization: "Bearer s3cr3t" }));

    expect(response.status).toBe(200);
    expect(applyBillingStatusExpiry).not.toHaveBeenCalled();
  });

  it("trial vencido mas AINDA dentro da tolerância de 24h de regularização NÃO dispara nada (regra definitiva de produto)", async () => {
    const now = Date.now();
    trialGet.mockResolvedValue({
      docs: [{ data: () => ({ id: "est-a", billing: { billingStatus: "trial", trialEndsAt: now - 1000 } }) }],
    });

    const response = await GET(req("https://example.test/api/cron/billing-expiry", { authorization: "Bearer s3cr3t" }));

    expect(response.status).toBe(200);
    expect(applyBillingStatusExpiry).not.toHaveBeenCalled();
  });

  it("1ms antes do fim da tolerância de 24h NÃO dispara; exatamente no fim, dispara", async () => {
    // Date.now() do próprio route precisa bater EXATAMENTE com o `now` usado
    // pra montar o fixture — só vi.useFakeTimers() garante isso num limite
    // de 1ms (relógio de parede real seria inerentemente instável aqui).
    vi.useFakeTimers();
    try {
      const now = Date.now();
      trialGet.mockResolvedValue({
        docs: [{ data: () => ({ id: "est-a", billing: { billingStatus: "trial", trialEndsAt: now - TRIAL_GRACE_WINDOW_MS + 1 } }) }],
      });
      await GET(req("https://example.test/api/cron/billing-expiry", { authorization: "Bearer s3cr3t" }));
      expect(applyBillingStatusExpiry).not.toHaveBeenCalled();

      vi.clearAllMocks();
      trialGet.mockResolvedValue({
        docs: [{ data: () => ({ id: "est-a", billing: { billingStatus: "trial", trialEndsAt: now - TRIAL_GRACE_WINDOW_MS } }) }],
      });
      applyBillingStatusExpiry.mockResolvedValue("applied");
      await GET(req("https://example.test/api/cron/billing-expiry", { authorization: "Bearer s3cr3t" }));
      expect(applyBillingStatusExpiry).toHaveBeenCalledWith("est-a", "trial_expired", expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });

  it("past_due com carência de 3 dias vencida dispara grace_expired", async () => {
    const now = Date.now();
    pastDueGet.mockResolvedValue({
      docs: [{ data: () => ({ id: "est-b", billing: { billingStatus: "past_due", lastAsaasEventAt: now - GRACE_MS - 1000 } }) }],
    });
    applyBillingStatusExpiry.mockResolvedValue("applied");

    const response = await GET(req("https://example.test/api/cron/billing-expiry", { authorization: "Bearer s3cr3t" }));

    expect(applyBillingStatusExpiry).toHaveBeenCalledWith("est-b", "grace_expired", expect.any(Number));
    const body = await response.json();
    expect(body.results).toEqual([{ establishmentId: "est-b", event: "grace_expired", outcome: "applied" }]);
  });

  it("past_due ainda dentro da carência de 3 dias NÃO dispara nada", async () => {
    const now = Date.now();
    pastDueGet.mockResolvedValue({
      docs: [{ data: () => ({ id: "est-b", billing: { billingStatus: "past_due", lastAsaasEventAt: now - GRACE_MS + 60_000 } }) }],
    });

    await GET(req("https://example.test/api/cron/billing-expiry", { authorization: "Bearer s3cr3t" }));

    expect(applyBillingStatusExpiry).not.toHaveBeenCalled();
  });

  it("past_due sem lastAsaasEventAt confiável nunca é suspenso (fail-safe)", async () => {
    pastDueGet.mockResolvedValue({
      docs: [{ data: () => ({ id: "est-c", billing: { billingStatus: "past_due" } }) }],
    });

    await GET(req("https://example.test/api/cron/billing-expiry", { authorization: "Bearer s3cr3t" }));

    expect(applyBillingStatusExpiry).not.toHaveBeenCalled();
  });

  it("uma falha num establishment não impede os demais", async () => {
    const now = Date.now();
    trialGet.mockResolvedValue({
      docs: [
        { data: () => ({ id: "est-fail", billing: { billingStatus: "trial", trialEndsAt: now - TRIAL_GRACE_WINDOW_MS - 1000 } }) },
        { data: () => ({ id: "est-ok", billing: { billingStatus: "trial", trialEndsAt: now - TRIAL_GRACE_WINDOW_MS - 1000 } }) },
      ],
    });
    applyBillingStatusExpiry.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("applied");

    const response = await GET(req("https://example.test/api/cron/billing-expiry", { authorization: "Bearer s3cr3t" }));

    const body = await response.json();
    expect(body.errors).toHaveLength(1);
    expect(body.results).toHaveLength(1);
  });
});
