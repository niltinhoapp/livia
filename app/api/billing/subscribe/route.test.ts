import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRIAL_PAYMENT_WINDOW_MS, TRIAL_GRACE_WINDOW_MS } from "@/lib/billing/trialWindow";
import type { Establishment } from "@/types";

const resolveEstablishmentId = vi.fn();
const getEstablishment = vi.fn();
const linkEstablishmentBilling = vi.fn();
const resolveOrCreateAsaasCustomer = vi.fn();
const provisionAsaasSubscription = vi.fn();
const getBillingProvisioningIntent = vi.fn(async (..._a: unknown[]): Promise<{ terms: { nextDueDate: string } } | null> => null);
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
  getBillingProvisioningIntent: (...a: unknown[]) => getBillingProvisioningIntent(...a),
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

  it("11) externalSubscriptionId (e a geração usada) é persistido quando a subscription é confirmada", async () => {
    provisionAsaasSubscription.mockResolvedValue(subscriptionSucceeded("sub_persist"));
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(linkEstablishmentBilling).toHaveBeenCalledWith(EST_ID, {
      externalSubscriptionId: "sub_persist",
      subscriptionGeneration: 1,
    });
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

  it("14) falha estrutural no provisioning -> 409 específico (nunca 502 genérico), reason fora da allowlist nunca vaza texto livre", async () => {
    provisionAsaasSubscription.mockResolvedValue({
      ok: false,
      phase: "failed_terminal",
      reason: "known_subscription_mismatch: chave secreta interna XPTO",
    });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain("XPTO");
    expect(text).not.toContain("known_subscription_mismatch");
    expect(JSON.parse(text)).toEqual({ error: "SUBSCRIPTION_CONFLICT", reason: "unknown" });
  });

  it("14c) falha estrutural conhecida (known_subscription_inactive) -> 409 com o motivo específico, nunca 502", async () => {
    provisionAsaasSubscription.mockResolvedValue({
      ok: false,
      phase: "conflict",
      reason: "known_subscription_inactive",
    });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "SUBSCRIPTION_CONFLICT", reason: "known_subscription_inactive" });
  });

  it("14d) falha transitória (intent_changed) -> 202 processing, nunca erro definitivo", async () => {
    provisionAsaasSubscription.mockResolvedValue({ ok: false, phase: "conflict", reason: "intent_changed" });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "processing" });
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

  // ---- OT de recontratação/provisionamento ----

  it("21) mesmo dia (nenhum intent gravado ainda): nextDueDate é calculado como hoje", async () => {
    getBillingProvisioningIntent.mockResolvedValue(null);
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    const [input] = provisionAsaasSubscription.mock.calls[0]!;
    expect(input.nextDueDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it("22) retomada em outro dia (intent já existe com nextDueDate de antes): reusa o valor gravado, nunca recalcula", async () => {
    getBillingProvisioningIntent.mockResolvedValue({
      terms: { nextDueDate: "2026-01-05" },
    });
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    const [input] = provisionAsaasSubscription.mock.calls[0]!;
    expect(input.nextDueDate).toBe("2026-01-05");
    expect(input.nextDueDate).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it("23) PIX pendente (intent 'reserved'/'creating', sem sucesso ainda): retomada reusa o mesmo nextDueDate/geração", async () => {
    getBillingProvisioningIntent.mockResolvedValue({ terms: { nextDueDate: "2026-02-10" } });
    // trialEndsAt perto o bastante do "agora" do teste pra cair dentro da
    // janela em que o gate de trial (lib/billing/trialWindow.ts) já libera
    // pagamento — o teste 23 é sobre reuso de nextDueDate/geração, não
    // sobre o gate em si (esse tem testes dedicados mais abaixo).
    getEstablishment.mockResolvedValue(establishment({ billing: { billingStatus: "trial", trialEndsAt: Date.now() + 1000, updatedAt: 1 } }));
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    const [input] = provisionAsaasSubscription.mock.calls[0]!;
    expect(input.nextDueDate).toBe("2026-02-10");
    expect(input.subscriptionGeneration).toBe(1);
  });

  it("24) timeout/corrida (provisioning devolve intent_changed): 202 processing, nunca erro definitivo", async () => {
    provisionAsaasSubscription.mockResolvedValue({ ok: false, phase: "conflict", reason: "intent_changed" });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "processing" });
  });

  it("25) subscription cancelada/inativa persistida (known_subscription_inactive): 409 específico, nunca 502", async () => {
    provisionAsaasSubscription.mockResolvedValue({ ok: false, phase: "conflict", reason: "known_subscription_inactive" });
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "SUBSCRIPTION_CONFLICT", reason: "known_subscription_inactive" });
  });

  it("26) billingStatus 'canceled': recontrata numa geração nova, nunca reusa a geração cancelada", async () => {
    getEstablishment.mockResolvedValue(
      establishment({ billing: { billingStatus: "canceled", subscriptionGeneration: 1, updatedAt: 1 } }),
    );
    getBillingProvisioningIntent.mockResolvedValue(null); // geração 2 nunca teve intent ainda
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(getBillingProvisioningIntent).toHaveBeenCalledWith(EST_ID, 2);
    const [input] = provisionAsaasSubscription.mock.calls[0]!;
    expect(input.subscriptionGeneration).toBe(2);
  });

  it("26b) billingStatus 'canceled' sem subscriptionGeneration prévio (establishment mais antigo que o campo): recontrata na geração 2", async () => {
    getEstablishment.mockResolvedValue(establishment({ billing: { billingStatus: "canceled", updatedAt: 1 } }));
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    const [input] = provisionAsaasSubscription.mock.calls[0]!;
    expect(input.subscriptionGeneration).toBe(2);
  });

  it("27) sucesso na recontratação persiste a NOVA geração junto do externalSubscriptionId", async () => {
    getEstablishment.mockResolvedValue(
      establishment({ billing: { billingStatus: "canceled", subscriptionGeneration: 1, updatedAt: 1 } }),
    );
    provisionAsaasSubscription.mockResolvedValue(subscriptionSucceeded("sub_geracao_2"));
    await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(linkEstablishmentBilling).toHaveBeenCalledWith(EST_ID, {
      externalSubscriptionId: "sub_geracao_2",
      subscriptionGeneration: 2,
    });
  });

  it("28) tenant não-canceled nunca recontrata: geração sempre a mesma persistida, mesmo em trial/past_due/suspended", async () => {
    for (const billingStatus of ["trial", "past_due", "suspended"] as const) {
      getBillingProvisioningIntent.mockClear();
      provisionAsaasSubscription.mockClear();
      getEstablishment.mockResolvedValue(
        establishment({ billing: { billingStatus, subscriptionGeneration: 3, trialEndsAt: Date.now() + 1000, updatedAt: 1 } }),
      );
      await POST(request({ cpfCnpj: "52998224725" }) as never);
      const [input] = provisionAsaasSubscription.mock.calls[0]!;
      expect(input.subscriptionGeneration).toBe(3);
    }
  });

  // -----------------------------------------------------------------
  // Regra definitiva do trial (auditoria pré-primeiro-pagamento real):
  // nenhuma cobrança PIX pode nascer antes de trialEndsAt-24h — nem
  // mesmo chamando a rota diretamente, sem passar pela UI.
  // -----------------------------------------------------------------
  it("29) antes de trialEndsAt-24h -> 403 TRIAL_PAYMENT_NOT_YET_AVAILABLE, nenhuma chamada Asaas", async () => {
    const now = Date.now();
    getEstablishment.mockResolvedValue(
      establishment({ billing: { billingStatus: "trial", trialEndsAt: now + 6 * 24 * 3600000, updatedAt: 1 } }),
    );
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "TRIAL_PAYMENT_NOT_YET_AVAILABLE" });
    expect(resolveOrCreateAsaasCustomer).not.toHaveBeenCalled();
    expect(provisionAsaasSubscription).not.toHaveBeenCalled();
    expect(createAsaasClient).not.toHaveBeenCalled();
  });

  it("30) exatamente em trialEndsAt-24h -> pagamento liberado, segue normalmente", async () => {
    const now = Date.now();
    getEstablishment.mockResolvedValue(
      establishment({ billing: { billingStatus: "trial", trialEndsAt: now + TRIAL_PAYMENT_WINDOW_MS, updatedAt: 1 } }),
    );
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(200);
    expect(provisionAsaasSubscription).toHaveBeenCalled();
  });

  it("31) imediatamente antes de trialEndsAt -> pagamento ainda disponível", async () => {
    const now = Date.now();
    getEstablishment.mockResolvedValue(
      establishment({ billing: { billingStatus: "trial", trialEndsAt: now + 1, updatedAt: 1 } }),
    );
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(200);
    expect(provisionAsaasSubscription).toHaveBeenCalled();
  });

  it("32) exatamente em trialEndsAt (início da tolerância) -> pagamento disponível, NÃO bloqueado", async () => {
    const now = Date.now();
    getEstablishment.mockResolvedValue(
      establishment({ billing: { billingStatus: "trial", trialEndsAt: now, updatedAt: 1 } }),
    );
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(200);
    expect(provisionAsaasSubscription).toHaveBeenCalled();
  });

  it("33) durante as 24h de tolerância pós-trialEndsAt -> pagamento disponível (regularização)", async () => {
    const now = Date.now();
    getEstablishment.mockResolvedValue(
      establishment({ billing: { billingStatus: "trial", trialEndsAt: now - 12 * 3600000, updatedAt: 1 } }),
    );
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(200);
    expect(provisionAsaasSubscription).toHaveBeenCalled();
  });

  it("34) mesmo bem depois de trialEndsAt+24h (já expirado/suspenso), pagamento continua disponível pra regularizar", async () => {
    const now = Date.now();
    getEstablishment.mockResolvedValue(
      establishment({ billing: { billingStatus: "trial", trialEndsAt: now - TRIAL_GRACE_WINDOW_MS - 10 * 24 * 3600000, updatedAt: 1 } }),
    );
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(200);
    expect(provisionAsaasSubscription).toHaveBeenCalled();
  });

  it("35) billingStatus fora de 'trial' (past_due/suspended/canceled) nunca é bloqueado pelo gate de trial", async () => {
    for (const billingStatus of ["past_due", "suspended", "canceled"] as const) {
      provisionAsaasSubscription.mockClear();
      getEstablishment.mockResolvedValue(
        establishment({ billing: { billingStatus, trialEndsAt: Date.now() + 6 * 24 * 3600000, updatedAt: 1 } }),
      );
      const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
      expect(res.status).toBe(200);
      expect(provisionAsaasSubscription).toHaveBeenCalled();
    }
  });

  it("36) trialEndsAt ausente/corrompido durante trial nunca bloqueia pagamento (não é este gate que fica fail-closed)", async () => {
    getEstablishment.mockResolvedValue(establishment({ billing: { billingStatus: "trial", updatedAt: 1 } }));
    const res = await POST(request({ cpfCnpj: "52998224725" }) as never);
    expect(res.status).toBe(200);
    expect(provisionAsaasSubscription).toHaveBeenCalled();
  });
});
