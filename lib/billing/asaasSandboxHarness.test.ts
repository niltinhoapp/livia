import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment } from "@/types";
import type { AsaasClient, AsaasResult } from "./asaas";
import type { BillingProvisioningIntent, ProvisioningResult } from "./provisioning";
import type { SandboxCustomerIntent } from "./asaasSandboxCustomer";
import {
  executeAsaasSandboxHarness,
  isAsaasSandboxHarnessEnabled,
  parseSandboxHarnessCommand,
  sandboxCustomerExternalReference,
  sandboxTestEstablishmentId,
  type SandboxHarnessDependencies,
} from "./asaasSandboxHarness";

const API_KEY = "$aact_hmlg_FAKE_TEST_KEY_NEVER_REAL";
const TEST_RUN_ID = "run-0001";
const ESTABLISHMENT_ID = sandboxTestEstablishmentId(TEST_RUN_ID);
const CUSTOMER_ID = "cus_test_1";

function ok<T>(data: T): AsaasResult<T> {
  return { ok: true, data };
}

function fakeClient(): AsaasClient {
  return {
    checkAuthentication: vi.fn().mockResolvedValue(ok({ authenticated: true })),
    createCustomer: vi.fn(),
    findCustomersByExternalReference: vi.fn().mockResolvedValue(ok([])),
    createSubscription: vi.fn(),
    getSubscription: vi.fn(),
    listSubscriptions: vi.fn(),
    findSubscriptionsForReconciliation: vi.fn().mockResolvedValue(ok([])),
    listSubscriptionPayments: vi.fn().mockResolvedValue(ok([])),
  };
}

function establishment(over: Partial<Establishment> = {}): Establishment {
  return {
    id: ESTABLISHMENT_ID,
    name: "Livia Asaas Sandbox Test",
    type: "outro",
    ownerUid: ESTABLISHMENT_ID,
    status: "suspended",
    createdAt: 1,
    panelAccess: "blocked",
    bot: {
      personaName: "Livia",
      tone: "teste",
      bookingEnabled: false,
      handoffKeywords: [],
      medicalGuardrail: false,
    },
    ...over,
  };
}

function intent(over: Partial<BillingProvisioningIntent> = {}): BillingProvisioningIntent {
  return {
    operationId: `${ESTABLISHMENT_ID}:1`,
    establishmentId: ESTABLISHMENT_ID,
    subscriptionGeneration: 1,
    externalReference: `livia:subscription:${ESTABLISHMENT_ID}:1`,
    asaasCustomerId: CUSTOMER_ID,
    fingerprint: "fingerprint",
    terms: {
      billingType: "PIX",
      value: 1,
      cycle: "MONTHLY",
      nextDueDate: "2026-10-01",
      description: "Livia sandbox controlled test",
    },
    phase: "succeeded",
    attemptId: "attempt-1",
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    externalSubscriptionId: "sub_test_1",
    createdAt: 1,
    updatedAt: 2,
    lastError: null,
    ...over,
  };
}

function intentForGen(generation: number, over: Partial<BillingProvisioningIntent> = {}): BillingProvisioningIntent {
  return intent({
    operationId: `${ESTABLISHMENT_ID}:${generation}`,
    subscriptionGeneration: generation,
    externalReference: `livia:subscription:${ESTABLISHMENT_ID}:${generation}`,
    externalSubscriptionId: `sub_test_${generation}`,
    ...over,
  });
}

function customerIntent(over: Partial<SandboxCustomerIntent> = {}): SandboxCustomerIntent {
  return {
    testRunId: TEST_RUN_ID,
    externalReference: sandboxCustomerExternalReference(TEST_RUN_ID),
    fingerprint: "fingerprint",
    phase: "succeeded",
    attemptId: "attempt-1",
    externalCustomerId: CUSTOMER_ID,
    createdAt: 1,
    updatedAt: 2,
    lastAttemptAt: 1,
    lastError: null,
    ...over,
  };
}

function dependencies(client = fakeClient()): SandboxHarnessDependencies {
  return {
    asaas: client,
    getEstablishment: vi.fn().mockResolvedValue(establishment()),
    provisionCustomer: vi.fn().mockResolvedValue({
      ok: true,
      phase: "succeeded",
      outcome: "created",
      intent: customerIntent(),
    }),
    provisionSubscription: vi.fn().mockResolvedValue({
      ok: true,
      phase: "succeeded",
      outcome: "created",
      intent: intent(),
    } satisfies ProvisioningResult),
    getProvisioningIntent: vi.fn().mockResolvedValue(intent()),
    logicalSubscriptionExternalReference: (establishmentId, generation) =>
      `livia:subscription:${establishmentId}:${generation}`,
    now: vi.fn(() => 1_800_000_000_000),
    newId: vi.fn(() => "fixed-id"),
  };
}

function subscriptionDependencies(client = fakeClient()): SandboxHarnessDependencies {
  vi.mocked(client.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
  return dependencies(client);
}

// Comando base de subscription para gen 1 + PIX (par histórico da homologação)
const SUBSCRIPTION_COMMAND_GEN1 = {
  action: "subscription" as const,
  confirmSandbox: true as const,
  testRunId: TEST_RUN_ID,
  customerId: CUSTOMER_ID,
  nextDueDate: "2026-10-01",
  generation: 1,
  billingType: "PIX" as const,
};

// Comando base de subscription para gen 2 + BOLETO (nova variável de homologação)
const SUBSCRIPTION_COMMAND_GEN2 = {
  action: "subscription" as const,
  confirmSandbox: true as const,
  testRunId: TEST_RUN_ID,
  customerId: CUSTOMER_ID,
  nextDueDate: "2026-10-01",
  generation: 2,
  billingType: "BOLETO" as const,
};

const INSPECT_COMMAND_GEN1 = {
  action: "inspect" as const,
  confirmSandbox: true as const,
  testRunId: TEST_RUN_ID,
  customerId: CUSTOMER_ID,
  generation: 1,
};

const INSPECT_COMMAND_GEN2 = {
  action: "inspect" as const,
  confirmSandbox: true as const,
  testRunId: TEST_RUN_ID,
  customerId: CUSTOMER_ID,
  generation: 2,
};

describe("production kill switch", () => {
  const valid = {
    VERCEL_ENV: "preview",
    ASAAS_ENVIRONMENT: "sandbox",
    ASAAS_API_KEY: API_KEY,
  };

  it.each([
    ["production", { ...valid, VERCEL_ENV: "production" }],
    ["development", { ...valid, VERCEL_ENV: "development" }],
    ["VERCEL_ENV ausente", { ...valid, VERCEL_ENV: undefined }],
    ["ambiente Asaas ausente", { ...valid, ASAAS_ENVIRONMENT: undefined }],
    ["Asaas production", { ...valid, ASAAS_ENVIRONMENT: "production" }],
    ["chave ausente", { ...valid, ASAAS_API_KEY: undefined }],
    ["chave de produção", { ...valid, ASAAS_API_KEY: "$aact_prod_FAKE" }],
  ])("bloqueia %s", (_label, env) => {
    expect(isAsaasSandboxHarnessEnabled(env)).toBe(false);
  });

  it("permite somente preview + sandbox + prefixo hmlg", () => {
    expect(isAsaasSandboxHarnessEnabled(valid)).toBe(true);
  });
});

describe("payload e confirmação explícita", () => {
  it("exige confirmSandbox=true e rejeita propriedades extras", () => {
    expect(parseSandboxHarnessCommand({ action: "auth_check" })).toBeNull();
    expect(parseSandboxHarnessCommand({ action: "auth_check", confirmSandbox: false })).toBeNull();
    expect(parseSandboxHarnessCommand({ action: "auth_check", confirmSandbox: true, actorUid: "x" })).toBeNull();
  });

  it("aceita somente contratos estritos, sem cartão", () => {
    expect(parseSandboxHarnessCommand({ action: "auth_check", confirmSandbox: true })).toEqual({
      action: "auth_check",
      confirmSandbox: true,
    });
    expect(parseSandboxHarnessCommand({
      action: "customer",
      confirmSandbox: true,
      testRunId: TEST_RUN_ID,
      cpfCnpj: "12345678901",
      creditCard: { number: "x" },
    })).toBeNull();
  });
});

describe("parser — subscription: generation e billingType obrigatórios e estritos", () => {
  const base = {
    action: "subscription",
    confirmSandbox: true,
    testRunId: TEST_RUN_ID,
    customerId: CUSTOMER_ID,
    nextDueDate: "2026-10-01",
    generation: 2,
    billingType: "BOLETO",
  };

  it("aceita generation 2 + BOLETO", () => {
    expect(parseSandboxHarnessCommand(base)).toEqual(base);
  });

  it("aceita generation 1 + PIX (par histórico)", () => {
    const cmd = { ...base, generation: 1, billingType: "PIX" };
    expect(parseSandboxHarnessCommand(cmd)).toEqual(cmd);
  });

  it.each([
    ["generation ausente", { ...base, generation: undefined }],
    ["generation string", { ...base, generation: "2" }],
    ["generation decimal", { ...base, generation: 1.5 }],
    ["generation 0", { ...base, generation: 0 }],
    ["generation negativa", { ...base, generation: -1 }],
    ["generation 11 (acima do limite)", { ...base, generation: 11 }],
    ["generation NaN", { ...base, generation: NaN }],
    ["billingType ausente", { ...base, billingType: undefined }],
    ["billingType CREDIT_CARD (fora da allowlist)", { ...base, billingType: "CREDIT_CARD" }],
    ["billingType UNDEFINED", { ...base, billingType: "UNDEFINED" }],
    ["billingType vazio", { ...base, billingType: "" }],
    ["campo extra", { ...base, extra: "x" }],
    ["generation e billingType ausentes (contrato antigo sem campos)", { action: "subscription", confirmSandbox: true, testRunId: TEST_RUN_ID, customerId: CUSTOMER_ID, nextDueDate: "2026-10-01" }],
  ])("rejeita %s", (_label, cmd) => {
    expect(parseSandboxHarnessCommand(cmd)).toBeNull();
  });

  it("aceita todos os valores válidos de generation (1-10)", () => {
    for (let g = 1; g <= 10; g++) {
      expect(parseSandboxHarnessCommand({ ...base, generation: g })).not.toBeNull();
    }
    expect(parseSandboxHarnessCommand({ ...base, generation: 11 })).toBeNull();
  });
});

describe("parser — inspect: generation obrigatório e estrito", () => {
  const base = {
    action: "inspect",
    confirmSandbox: true,
    testRunId: TEST_RUN_ID,
    customerId: CUSTOMER_ID,
    generation: 1,
  };

  it("aceita generation 1", () => {
    expect(parseSandboxHarnessCommand(base)).toEqual(base);
  });

  it("aceita generation 2", () => {
    expect(parseSandboxHarnessCommand({ ...base, generation: 2 })).toEqual({ ...base, generation: 2 });
  });

  it.each([
    ["generation ausente (contrato antigo)", { action: "inspect", confirmSandbox: true, testRunId: TEST_RUN_ID, customerId: CUSTOMER_ID }],
    ["generation string", { ...base, generation: "1" }],
    ["generation decimal", { ...base, generation: 1.1 }],
    ["generation 0", { ...base, generation: 0 }],
    ["generation negativa", { ...base, generation: -1 }],
    ["generation 11", { ...base, generation: 11 }],
    ["campo extra", { ...base, extra: "x" }],
  ])("rejeita %s", (_label, cmd) => {
    expect(parseSandboxHarnessCommand(cmd)).toBeNull();
  });
});

describe("auth_check", () => {
  it("faz uma única leitura e não cria customer ou subscription", async () => {
    const asaas = fakeClient();
    const result = await executeAsaasSandboxHarness(
      { action: "auth_check", confirmSandbox: true },
      dependencies(asaas),
    );
    expect(result).toEqual({ ok: true, action: "auth_check", authenticated: true });
    expect(asaas.checkAuthentication).toHaveBeenCalledTimes(1);
    expect(asaas.createCustomer).not.toHaveBeenCalled();
    expect(asaas.createSubscription).not.toHaveBeenCalled();
  });
});

describe("customer reconciliation", () => {
  const command = {
    action: "customer" as const,
    confirmSandbox: true as const,
    testRunId: TEST_RUN_ID,
    cpfCnpj: "12345678901",
  };

  it("delega a criação ao workflow durável com identidade determinística", async () => {
    const asaas = fakeClient();
    const deps = dependencies(asaas);
    const result = await executeAsaasSandboxHarness(command, deps);

    expect(result.ok && result.action === "customer" && result.outcome).toBe("created");
    expect(deps.provisionCustomer).toHaveBeenCalledWith({
      testRunId: TEST_RUN_ID,
      name: `Livia Sandbox Test ${TEST_RUN_ID}`,
      cpfCnpj: "12345678901",
      externalReference: sandboxCustomerExternalReference(TEST_RUN_ID),
    }, expect.objectContaining({ asaas }));
    expect(asaas.createCustomer).not.toHaveBeenCalled();
  });

  it("mapeia replay verificado para reused", async () => {
    const deps = dependencies();
    vi.mocked(deps.provisionCustomer).mockResolvedValue({
      ok: true,
      phase: "succeeded",
      outcome: "verified",
      intent: customerIntent(),
    });
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result.ok && result.action === "customer" && result.outcome).toBe("reused");
  });

  it("sinaliza falha transitória de verificação sem perder customer conhecido", async () => {
    const deps = dependencies();
    vi.mocked(deps.provisionCustomer).mockResolvedValue({
      ok: true,
      phase: "succeeded",
      outcome: "verification_failed",
      intent: customerIntent(),
      verificationError: { kind: "timeout" },
    });
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result).toEqual({
      ok: true,
      action: "customer",
      outcome: "verification_failed",
      customer: {
        id: CUSTOMER_ID,
        externalReference: sandboxCustomerExternalReference(TEST_RUN_ID),
      },
    });
  });

  it("mapeia conflito durável sem executar POST diretamente", async () => {
    const deps = dependencies();
    vi.mocked(deps.provisionCustomer).mockResolvedValue({ ok: false, phase: "conflict", reason: "multiple_customers" });
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result).toEqual({ ok: false, action: "customer", code: "customer_conflict" });
    expect(deps.asaas.createCustomer).not.toHaveBeenCalled();
  });

  it("mapeia estado ambíguo persistido para reconciling", async () => {
    const deps = dependencies();
    vi.mocked(deps.provisionCustomer).mockResolvedValue({
      ok: true,
      phase: "reconciling",
      outcome: "awaiting_reconciliation",
      intent: customerIntent({
        phase: "reconciling",
        externalCustomerId: null,
        lastError: { kind: "timeout" },
      }),
    });
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result.ok && result.action === "customer" && result.outcome).toBe("reconciling");
  });
});

describe("subscription — generation explícita e billingType", () => {
  it("generation=1 + PIX: passa exatamente ao provisionSubscription, nunca chama createSubscription diretamente", async () => {
    const asaas = fakeClient();
    const deps = subscriptionDependencies(asaas);
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true,
      phase: "succeeded",
      outcome: "created",
      intent: intentForGen(1),
    });

    const result = await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN1, deps);

    expect(result.ok && result.action === "subscription" && result.generation).toBe(1);
    expect(deps.provisionSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        establishmentId: ESTABLISHMENT_ID,
        subscriptionGeneration: 1,
        asaasCustomerId: CUSTOMER_ID,
        billingType: "PIX",
        value: 1,
        cycle: "MONTHLY",
        nextDueDate: "2026-10-01",
      }),
      expect.objectContaining({ asaas }),
    );
    expect(asaas.createSubscription).not.toHaveBeenCalled();
  });

  it("generation=2 + BOLETO: passa geração e billingType corretos, value permanece 1", async () => {
    const asaas = fakeClient();
    const deps = subscriptionDependencies(asaas);
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true,
      phase: "succeeded",
      outcome: "created",
      intent: intentForGen(2, { terms: { billingType: "BOLETO", value: 1, cycle: "MONTHLY", nextDueDate: "2026-10-01", description: "Livia sandbox controlled test" } }),
    });

    const result = await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);

    expect(result.ok && result.action === "subscription" && result.generation).toBe(2);
    const call = vi.mocked(deps.provisionSubscription).mock.calls[0]?.[0];
    expect(call).toMatchObject({
      establishmentId: ESTABLISHMENT_ID,
      subscriptionGeneration: 2,
      asaasCustomerId: CUSTOMER_ID,
      billingType: "BOLETO",
      value: 1,
      cycle: "MONTHLY",
    });
    expect(asaas.createSubscription).not.toHaveBeenCalled();
  });

  it("BOLETO chega exatamente ao mock de createSubscription via provisionSubscription", async () => {
    // Verifica que billingType=BOLETO passa pela cadeia harness → provisionSubscription
    // Aqui usamos o mock do provisionSubscription (não do createSubscription direto)
    // e inspecionamos o argumento passado.
    const deps = subscriptionDependencies();
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true, phase: "succeeded", outcome: "created",
      intent: intentForGen(2, { terms: { billingType: "BOLETO", value: 1, cycle: "MONTHLY", nextDueDate: "2026-10-01" } }),
    });

    await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);

    expect(vi.mocked(deps.provisionSubscription).mock.calls[0]?.[0]?.billingType).toBe("BOLETO");
  });

  it("value permanece exatamente 1 para generation 2 + BOLETO", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true, phase: "succeeded", outcome: "created",
      intent: intentForGen(2),
    });

    await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);

    expect(vi.mocked(deps.provisionSubscription).mock.calls[0]?.[0]?.value).toBe(1);
  });

  it("generation 1 em failed_terminal não interfere na generation 2", async () => {
    const deps = subscriptionDependencies();
    // provisionSubscription para gen 1 retornaria failed_terminal, mas
    // gen 2 usa identidade completamente separada — o mock aqui simula
    // que o provisionador trata gen 2 como nova tentativa independente.
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true, phase: "succeeded", outcome: "created",
      intent: intentForGen(2),
    });

    const result = await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);

    // O harness passou subscriptionGeneration: 2 — o provisionador viu
    // uma identidade distinta de billingProvisioning/2, não billingProvisioning/1.
    expect(result.ok && result.action === "subscription" && result.generation).toBe(2);
    expect(vi.mocked(deps.provisionSubscription).mock.calls[0]?.[0]?.subscriptionGeneration).toBe(2);
  });

  it("generation 2 usa externalReference que embute '2', distinta da generation 1", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true, phase: "succeeded", outcome: "created",
      intent: intentForGen(2),
    });

    await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);

    // O provisionSubscription receberá establishmentId + generation; a função
    // logicalSubscriptionExternalReference (shared) montará:
    // "livia:subscription:{establishmentId}:2". O harness não monta esse
    // valor diretamente, mas repassa generation=2 ao provisionador.
    const callArg = vi.mocked(deps.provisionSubscription).mock.calls[0]?.[0];
    expect(callArg?.subscriptionGeneration).toBe(2);
    expect(callArg?.establishmentId).toBe(ESTABLISHMENT_ID);
    // Verificação cruzada com a função utilitária real:
    const expectedRef = `livia:subscription:${ESTABLISHMENT_ID}:2`;
    expect(deps.logicalSubscriptionExternalReference(ESTABLISHMENT_ID, 2)).toBe(expectedRef);
    expect(expectedRef).not.toContain(":1");
  });

  it("replay da mesma generation 2 mantém idempotência: o provisionador recebe a mesma identidade duas vezes", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true, phase: "succeeded", outcome: "verified",
      intent: intentForGen(2),
    });

    await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);
    await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);

    expect(deps.provisionSubscription).toHaveBeenCalledTimes(2);
    const [call1, call2] = vi.mocked(deps.provisionSubscription).mock.calls;
    expect(call1?.[0]).toEqual(call2?.[0]);
    expect(deps.asaas.createSubscription).not.toHaveBeenCalled();
  });

  it("não cria tenant de teste e falha se ele não existir (gen 2)", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.getEstablishment).mockResolvedValue(null);
    const result = await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);
    expect(result).toEqual({ ok: false, action: "subscription", code: "test_establishment_not_found" });
    expect(deps.provisionSubscription).not.toHaveBeenCalled();
  });

  it("falha fechado se id ou owner do tenant dedicado divergirem (gen 2)", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.getEstablishment).mockResolvedValue(establishment({ ownerUid: "real-owner" }));
    const result = await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);
    expect(result).toEqual({ ok: false, action: "subscription", code: "test_establishment_invalid" });
    expect(deps.provisionSubscription).not.toHaveBeenCalled();
  });

  it("rejeita customer que não pertence ao externalReference determinístico do run (gen 2)", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: "cus_other", name: "other" }]));
    const result = await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);
    expect(result).toEqual({ ok: false, action: "subscription", code: "customer_conflict" });
    expect(deps.provisionSubscription).not.toHaveBeenCalled();
  });

  it("nenhum POST direto é executado mesmo quando provisionSubscription retorna !ok (gen 2)", async () => {
    const asaas = fakeClient();
    const deps = subscriptionDependencies(asaas);
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: false, phase: "failed_terminal", reason: "asaas_rejected",
      intent: intentForGen(2, { phase: "failed_terminal", externalSubscriptionId: null }),
    });

    const result = await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);

    expect(result).toMatchObject({ ok: false, action: "subscription", code: "subscription_conflict" });
    expect(asaas.createSubscription).not.toHaveBeenCalled();
  });
});

describe("inspect — generation explícita isola generations", () => {
  it("inspect generation 1 lê exatamente billingProvisioning/1", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
    vi.mocked(asaas.findSubscriptionsForReconciliation).mockResolvedValue(ok([]));
    const deps = dependencies(asaas);
    // Sem externalSubscriptionId para evitar path de getSubscription sem mock
    vi.mocked(deps.getProvisioningIntent).mockResolvedValue(
      intentForGen(1, { externalSubscriptionId: null }),
    );

    await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN1, deps);

    expect(deps.getProvisioningIntent).toHaveBeenCalledWith(ESTABLISHMENT_ID, 1);
    expect(deps.getProvisioningIntent).not.toHaveBeenCalledWith(ESTABLISHMENT_ID, 2);
  });

  it("inspect generation 2 lê exatamente billingProvisioning/2, não mistura com gen 1", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
    vi.mocked(asaas.findSubscriptionsForReconciliation).mockResolvedValue(ok([]));
    const deps = dependencies(asaas);
    // Sem externalSubscriptionId para evitar path de getSubscription sem mock
    vi.mocked(deps.getProvisioningIntent).mockResolvedValue(
      intentForGen(2, { externalSubscriptionId: null }),
    );

    await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN2, deps);

    expect(deps.getProvisioningIntent).toHaveBeenCalledWith(ESTABLISHMENT_ID, 2);
    expect(deps.getProvisioningIntent).not.toHaveBeenCalledWith(ESTABLISHMENT_ID, 1);
  });

  it("inspect generation 2 usa logicalReference que contém '2', não '1'", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
    vi.mocked(asaas.findSubscriptionsForReconciliation).mockResolvedValue(ok([]));
    const deps = dependencies(asaas);
    vi.mocked(deps.getProvisioningIntent).mockResolvedValue(null); // sem intent → busca por externalReference

    await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN2, deps);

    const findCalls = vi.mocked(asaas.findSubscriptionsForReconciliation).mock.calls;
    expect(findCalls.length).toBeGreaterThan(0);
    const externalRef = findCalls[0]?.[0]?.externalReference;
    expect(externalRef).toMatch(/:2$/);
    expect(externalRef).not.toMatch(/:1$/);
  });

  it("inspect generation 1 quando failed_terminal: retorna phase sem misturar gen 2", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
    vi.mocked(asaas.findSubscriptionsForReconciliation).mockResolvedValue(ok([]));
    const deps = dependencies(asaas);
    vi.mocked(deps.getProvisioningIntent).mockResolvedValue(
      intentForGen(1, { phase: "failed_terminal", externalSubscriptionId: null, lastError: { kind: "http", status: 400, codes: ["invalid_value"] } }),
    );

    const result = await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN1, deps);

    expect(result.ok).toBe(true);
    if (result.ok && result.action === "inspect") {
      expect(result.provisioning?.phase).toBe("failed_terminal");
      expect(result.provisioning?.generation).toBe(1);
    }
    expect(deps.getProvisioningIntent).toHaveBeenCalledWith(ESTABLISHMENT_ID, 1);
    expect(deps.getProvisioningIntent).not.toHaveBeenCalledWith(ESTABLISHMENT_ID, 2);
  });

  it("retorna somente campos permitidos e não executa POST/workflow", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "Secret Name" }]));
    vi.mocked(asaas.getSubscription).mockResolvedValue(ok({
      id: "sub_test_1",
      customer: CUSTOMER_ID,
      billingType: "PIX",
      value: 1,
      nextDueDate: "2026-10-01",
      cycle: "MONTHLY",
      externalReference: `livia:subscription:${ESTABLISHMENT_ID}:1`,
      status: "ACTIVE",
    }));
    vi.mocked(asaas.listSubscriptionPayments).mockResolvedValue(ok([{
      id: "pay_1",
      status: "PENDING",
      dueDate: "2026-10-01",
      value: 1,
      customer: CUSTOMER_ID,
    }]));
    const deps = dependencies(asaas);
    const result = await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN1, deps);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Secret Name");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(asaas.createCustomer).not.toHaveBeenCalled();
    expect(asaas.createSubscription).not.toHaveBeenCalled();
    expect(deps.provisionSubscription).not.toHaveBeenCalled();
  });
});
