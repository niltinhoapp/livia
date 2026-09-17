import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment } from "@/types";

const resolveEstablishmentId = vi.fn();
const getEstablishment = vi.fn();
const linkEstablishmentBilling = vi.fn();
const resolveOrCreateAsaasCustomer = vi.fn();
const provisionAsaasSubscription = vi.fn();
const resolvePixPaymentForSubscription = vi.fn();
const createAsaasClient = vi.fn((..._args: unknown[]) => ({ fakeClient: true }));

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: (...a: unknown[]) => resolveEstablishmentId(...a),
}));
vi.mock("@/lib/repo", () => ({
  getEstablishment: (...a: unknown[]) => getEstablishment(...a),
  linkEstablishmentBilling: (...a: unknown[]) => linkEstablishmentBilling(...a),
}));
vi.mock("@/lib/billing/customerIdentity", () => ({
  resolveOrCreateAsaasCustomer: (...a: unknown[]) => resolveOrCreateAsaasCustomer(...a),
}));
vi.mock("@/lib/billing/provisioning", () => ({
  provisionAsaasSubscription: (...a: unknown[]) => provisionAsaasSubscription(...a),
}));
vi.mock("@/lib/billing/pixPayment", () => ({
  resolvePixPaymentForSubscription: (...a: unknown[]) => resolvePixPaymentForSubscription(...a),
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

function request(body: unknown) {
  return new Request("https://livia.test/api/billing/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const DUE_DATE = "2026-09-17";

function customerOk(id = "cus_1") {
  return { ok: true, externalCustomerId: id, outcome: "created" as const };
}
function subscriptionSucceeded(subId = "sub_1") {
  return {
    ok: true,
    phase: "succeeded" as const,
    outcome: "created" as const,
    intent: { externalSubscriptionId: subId, terms: { nextDueDate: DUE_DATE } },
  };
}
function pixReady() {
  return { ok: true, status: "ready" as const, pixCopyPaste: "00020126...copia-cola", qrCode: "BASE64IMG" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ASAAS_API_KEY", "test-key");
  vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox");
  resolveEstablishmentId.mockResolvedValue(EST_ID);
  getEstablishment.mockResolvedValue(establishment());
  resolveOrCreateAsaasCustomer.mockResolvedValue(customerOk());
  provisionAsaasSubscription.mockResolvedValue(subscriptionSucceeded());
  resolvePixPaymentForSubscription.mockResolvedValue(pixReady());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/billing/subscribe", () => {
  it("1) não autenticado -> 401, nenhuma integração chamada", async () => {
    resolveEstablishmentId.mockResolvedValue(null);
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(401);
    expect(resolveOrCreateAsaasCustomer).not.toHaveBeenCalled();
    expect(provisionAsaasSubscription).not.toHaveBeenCalled();
  });

  it("2) establishment inexistente -> 404, nenhuma integração chamada", async () => {
    getEstablishment.mockResolvedValue(null);
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(404);
    expect(resolveOrCreateAsaasCustomer).not.toHaveBeenCalled();
  });

  it("3) CPF/CNPJ inválido/ausente -> 400 antes de qualquer integração", async () => {
    const res = await POST(request({}) as never);
    expect(res.status).toBe(400);
    expect(resolveOrCreateAsaasCustomer).not.toHaveBeenCalled();
    expect(provisionAsaasSubscription).not.toHaveBeenCalled();
  });

  it("4) customer existente (reconciled) segue para provisioning", async () => {
    resolveOrCreateAsaasCustomer.mockResolvedValue({ ok: true, externalCustomerId: "cus_existing", outcome: "reconciled" });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(200);
    expect(provisionAsaasSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ asaasCustomerId: "cus_existing" }),
      expect.anything(),
    );
  });

  it("5) customer novo (created) segue para provisioning", async () => {
    resolveOrCreateAsaasCustomer.mockResolvedValue({ ok: true, externalCustomerId: "cus_new", outcome: "created" });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(200);
    expect(provisionAsaasSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ asaasCustomerId: "cus_new" }),
      expect.anything(),
    );
  });

  it("6) subscription criada/reconciliada + PIX pronto -> 200 payment_required (não basta a subscription existir)", async () => {
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "payment_required",
      payment: { pixCopyPaste: "00020126...copia-cola", qrCode: "BASE64IMG" },
    });
  });

  it("7-9) preço/ciclo/billingType são sempre definidos server-side (R$129/MONTHLY/PIX)", async () => {
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(provisionAsaasSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ value: 129, cycle: "MONTHLY", billingType: "PIX" }),
      expect.anything(),
    );
  });

  it("7b) corpo tentando enviar value/cycle/billingType diferentes é ignorado", async () => {
    await POST(request({ cpfCnpj: "52998224725", value: 1, cycle: "YEARLY", billingType: "CREDIT_CARD" }) as never);
    expect(provisionAsaasSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ value: 129, cycle: "MONTHLY", billingType: "PIX" }),
      expect.anything(),
    );
  });

  it("10) externalCustomerId é persistido antes do provisioning", async () => {
    resolveOrCreateAsaasCustomer.mockResolvedValue({ ok: true, externalCustomerId: "cus_persist", outcome: "created" });
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(linkEstablishmentBilling).toHaveBeenCalledWith(EST_ID, { externalCustomerId: "cus_persist" });
  });

  it("11) externalSubscriptionId é persistido quando a subscription é confirmada", async () => {
    provisionAsaasSubscription.mockResolvedValue(subscriptionSucceeded("sub_persist"));
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(linkEstablishmentBilling).toHaveBeenCalledWith(EST_ID, { externalSubscriptionId: "sub_persist" });
  });

  it("12) repetição usa sempre a mesma identidade (establishmentId+generation) — idempotência delegada ao provisioning", async () => {
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(provisionAsaasSubscription).toHaveBeenCalledTimes(2);
    const [firstCallInput] = provisionAsaasSubscription.mock.calls[0]!;
    const [secondCallInput] = provisionAsaasSubscription.mock.calls[1]!;
    expect(firstCallInput.establishmentId).toBe(secondCallInput.establishmentId);
    expect(firstCallInput.subscriptionGeneration).toBe(secondCallInput.subscriptionGeneration);
  });

  it("13) establishmentId enviado pelo corpo é ignorado — nunca atua em outro tenant", async () => {
    await POST(request({ cpfCnpj: "52998224725", establishmentId: "est_outro_tenant" }) as never);
    expect(resolveOrCreateAsaasCustomer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ establishmentId: EST_ID }),
    );
    expect(provisionAsaasSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ establishmentId: EST_ID }),
      expect.anything(),
    );
  });

  it("14) falha externa no provisioning -> resposta segura, sem vazar reason/secret", async () => {
    provisionAsaasSubscription.mockResolvedValue({
      ok: false,
      phase: "failed_terminal",
      reason: "known_subscription_mismatch: chave secreta interna XPTO",
    });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("XPTO");
    expect(text).not.toContain("known_subscription_mismatch");
    expect(JSON.parse(text)).toEqual({ error: "SUBSCRIPTION_PROVISIONING_FAILED" });
  });

  it("14b) falha na resolução do customer -> resposta segura", async () => {
    resolveOrCreateAsaasCustomer.mockResolvedValue({ ok: false, reason: "create_failed" });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "CUSTOMER_RESOLUTION_FAILED" });
    expect(provisionAsaasSubscription).not.toHaveBeenCalled();
  });

  it("CPF/CNPJ nunca aparece na resposta", async () => {
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    const text = await res.text();
    expect(text).not.toContain("52998224725");
  });

  // ---- OT-07E2: cobrança PIX ----

  it("15) billingStatus já 'active': não pede CPF/CNPJ, não toca customer/subscription", async () => {
    getEstablishment.mockResolvedValue(establishment({ billing: { billingStatus: "active", updatedAt: 1 } }));
    const res = await POST(request({}) as never); // nem envia cpfCnpj — não deveria ser exigido
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "active" });
    expect(resolveOrCreateAsaasCustomer).not.toHaveBeenCalled();
    expect(provisionAsaasSubscription).not.toHaveBeenCalled();
  });

  it("16) cobrança pertence à subscription recém-provisionada (nunca a outra) — subscriptionId nunca vem do corpo", async () => {
    provisionAsaasSubscription.mockResolvedValue(subscriptionSucceeded("sub_correta"));
    await POST(request({ cpfCnpj: "52998224725", subscriptionId: "sub_de_outro_tenant" }) as never);
    expect(resolvePixPaymentForSubscription).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subscriptionId: "sub_correta", nextDueDate: DUE_DATE }),
    );
  });

  it("17) resposta payment_required não vaza customerId/subscriptionId/payload bruto do Asaas", async () => {
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    const text = await res.text();
    expect(text).not.toContain("cus_1");
    expect(text).not.toContain("sub_1");
  });

  it("18) cobrança ainda não gerada (corrida pós-criação) -> 202 processing, sem erro", async () => {
    resolvePixPaymentForSubscription.mockResolvedValue({ ok: true, status: "not_generated_yet" });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "processing" });
  });

  it("19) falha ao buscar a cobrança/QR -> 502 sanitizado", async () => {
    resolvePixPaymentForSubscription.mockResolvedValue({ ok: false, reason: "qrcode_failed" });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "PIX_LOOKUP_FAILED" });
  });

  it("20) repetição com subscription já reconciliada reutiliza a mesma cobrança (não recalcula nextDueDate a cada chamada)", async () => {
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    const firstCall = resolvePixPaymentForSubscription.mock.calls[0]!;
    const secondCall = resolvePixPaymentForSubscription.mock.calls[1]!;
    expect(firstCall[1].nextDueDate).toBe(secondCall[1].nextDueDate);
  });
});
