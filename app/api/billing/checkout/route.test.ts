import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Establishment } from "@/types";

const resolveEstablishmentId = vi.fn();
const getEstablishment = vi.fn();
const provisionBillingCheckout = vi.fn();
const getBillingCheckoutIntent = vi.fn(async (..._a: unknown[]): Promise<{ terms: { nextDueDate: string } } | null> => null);
const createAsaasClient = vi.fn((..._args: unknown[]) => ({ fakeClient: true }));

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: (...a: unknown[]) => resolveEstablishmentId(...a),
}));
vi.mock("@/lib/repo", () => ({
  getEstablishment: (...a: unknown[]) => getEstablishment(...a),
}));
vi.mock("@/lib/billing/checkoutProvisioning", () => ({
  provisionBillingCheckout: (...a: unknown[]) => provisionBillingCheckout(...a),
  getBillingCheckoutIntent: (...a: unknown[]) => getBillingCheckoutIntent(...a),
}));
vi.mock("@/lib/billing/asaas", () => ({
  createAsaasClient: (...a: unknown[]) => createAsaasClient(...a),
}));

const { POST } = await import("./route");

const EST_ID = "est_tenant_1";

function establishment(over: Partial<Establishment> = {}): Establishment {
  return {
    id: EST_ID,
    name: "Clínica Exemplo",
    type: "outro",
    ownerUid: EST_ID,
    status: "active",
    createdAt: 1,
    bot: {
      personaName: "Livia",
      tone: "acolhedora",
      bookingEnabled: false,
      handoffKeywords: [],
      medicalGuardrail: false,
    },
    ...over,
  };
}

function request(origin = "https://livia.test") {
  return new NextRequest(`${origin}/api/billing/checkout`, { method: "POST" });
}

function checkoutCreated(checkoutId = "chk_1", link = "https://sandbox.asaas.com/checkoutSession/show/chk_1") {
  return {
    ok: true,
    phase: "created" as const,
    outcome: "created" as const,
    intent: { checkoutId, checkoutLink: link },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ASAAS_API_KEY", "test-key");
  vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox");
  resolveEstablishmentId.mockResolvedValue(EST_ID);
  getEstablishment.mockResolvedValue(establishment());
  provisionBillingCheckout.mockResolvedValue(checkoutCreated());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/billing/checkout", () => {
  it("1) não autenticado -> 401, nenhuma integração chamada", async () => {
    resolveEstablishmentId.mockResolvedValue(null);
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(provisionBillingCheckout).not.toHaveBeenCalled();
  });

  it("2) establishment inexistente -> 404, nenhuma integração chamada", async () => {
    getEstablishment.mockResolvedValue(null);
    const res = await POST(request());
    expect(res.status).toBe(404);
    expect(provisionBillingCheckout).not.toHaveBeenCalled();
  });

  it("3) billingStatus já 'active' -> 200 {status:'active'}, idempotente, nenhum Checkout criado", async () => {
    getEstablishment.mockResolvedValue(establishment({ billing: { billingStatus: "active", updatedAt: 1 } }));
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "active" });
    expect(provisionBillingCheckout).not.toHaveBeenCalled();
  });

  it("4) Checkout criado -> 200 com checkoutUrl vindo exclusivamente do backend", async () => {
    provisionBillingCheckout.mockResolvedValue(checkoutCreated("chk_xyz", "https://sandbox.asaas.com/checkoutSession/show/chk_xyz"));
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "checkout_created",
      checkoutUrl: "https://sandbox.asaas.com/checkoutSession/show/chk_xyz",
    });
  });

  it("5) preço/ciclo são sempre definidos server-side (R$129/MONTHLY), billingTypes/chargeTypes fixos em CREDIT_CARD/RECURRENT", async () => {
    await POST(request());
    expect(provisionBillingCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ value: 129, cycle: "MONTHLY" }),
      expect.anything(),
    );
  });

  it("6) URLs de retorno usam a origem real da requisição, com query string distinta por desfecho", async () => {
    await POST(request("https://preview-123.vercel.app"));
    expect(provisionBillingCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl: "https://preview-123.vercel.app/painel/plano?checkout=success",
        cancelUrl: "https://preview-123.vercel.app/painel/plano?checkout=cancel",
        expiredUrl: "https://preview-123.vercel.app/painel/plano?checkout=expired",
      }),
      expect.anything(),
    );
  });

  it("7) double-click/concorrência: provisionBillingCheckout devolve 'busy' -> 202, sem checkoutUrl (mesma chamada é segura repetir)", async () => {
    provisionBillingCheckout.mockResolvedValue({ ok: true, phase: "reserved", outcome: "busy", intent: {} });
    const res = await POST(request());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.checkoutUrl).toBeUndefined();
  });

  it("8) rejeição conclusiva da Asaas -> 409 CHECKOUT_CONFLICT com reason específico, nunca 502 genérico", async () => {
    provisionBillingCheckout.mockResolvedValue({ ok: false, phase: "failed_terminal", reason: "asaas_rejected" });
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "CHECKOUT_CONFLICT", reason: "asaas_rejected" });
  });

  it("9) motivo de conflito desconhecido/inesperado nunca é ecoado como texto livre -> 'unknown'", async () => {
    provisionBillingCheckout.mockResolvedValue({ ok: false, phase: "conflict", reason: "algo-nao-mapeado-<script>" });
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "CHECKOUT_CONFLICT", reason: "unknown" });
  });

  it("10) ASAAS_API_KEY/ASAAS_ENVIRONMENT ausentes -> 503, nenhuma tentativa de criar Checkout", async () => {
    vi.stubEnv("ASAAS_API_KEY", "");
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(provisionBillingCheckout).not.toHaveBeenCalled();
  });

  it("11) generation é resolvida a partir do billing existente (canceled avança a geração), nunca aceita valor externo", async () => {
    getEstablishment.mockResolvedValue(establishment({ billing: { billingStatus: "canceled", subscriptionGeneration: 2, updatedAt: 1 } }));
    await POST(request());
    expect(provisionBillingCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionGeneration: 3 }),
      expect.anything(),
    );
  });
});
