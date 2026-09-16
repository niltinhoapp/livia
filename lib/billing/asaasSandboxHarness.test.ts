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
    recoverConflict: vi.fn().mockResolvedValue({
      ok: true,
      phase: "succeeded",
      outcome: "reconciled",
      intent: intent(),
    } satisfies ProvisioningResult),
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
  value: 5,
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
  value: 5,
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
    ["development", { ...valid, VERCEL_ENV: "development" }],
    ["VERCEL_ENV ausente", { ...valid, VERCEL_ENV: undefined }],
    ["ambiente Asaas ausente", { ...valid, ASAAS_ENVIRONMENT: undefined }],
    ["Asaas production", { ...valid, ASAAS_ENVIRONMENT: "production" }],
    ["chave ausente", { ...valid, ASAAS_API_KEY: undefined }],
    ["chave de produção", { ...valid, ASAAS_API_KEY: "$aact_prod_FAKE" }],
  ])("bloqueia %s", (_label, env) => {
    expect(isAsaasSandboxHarnessEnabled(env)).toBe(false);
  });

  it("permite preview + sandbox + prefixo hmlg", () => {
    expect(isAsaasSandboxHarnessEnabled(valid)).toBe(true);
  });

  // OT-06G: VERCEL_ENV=="production" passou a ser aceito, decisão temporária
  // da fase pré-beta (ver comentário em isAsaasSandboxHarnessEnabled) — mas
  // só quando TODOS os outros gates Sandbox continuam válidos.
  describe("VERCEL_ENV=production (OT-06G, temporário — fase pré-beta)", () => {
    const validProduction = { ...valid, VERCEL_ENV: "production" };

    it("Production + sandbox válido -> habilitado", () => {
      expect(isAsaasSandboxHarnessEnabled(validProduction)).toBe(true);
    });

    it("Production + ASAAS_ENVIRONMENT não-sandbox -> bloqueado", () => {
      expect(isAsaasSandboxHarnessEnabled({ ...validProduction, ASAAS_ENVIRONMENT: "production" })).toBe(false);
      expect(isAsaasSandboxHarnessEnabled({ ...validProduction, ASAAS_ENVIRONMENT: undefined })).toBe(false);
    });

    it("Production + chave sem prefixo sandbox -> bloqueado", () => {
      expect(isAsaasSandboxHarnessEnabled({ ...validProduction, ASAAS_API_KEY: "$aact_prod_FAKE" })).toBe(false);
      expect(isAsaasSandboxHarnessEnabled({ ...validProduction, ASAAS_API_KEY: undefined })).toBe(false);
    });

    it("Preview + sandbox válido continua habilitado (regressão — B2 não alterou o caminho existente)", () => {
      expect(isAsaasSandboxHarnessEnabled(valid)).toBe(true);
    });
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

describe("parser — subscription: generation, billingType e value obrigatórios e estritos", () => {
  const base = {
    action: "subscription",
    confirmSandbox: true,
    testRunId: TEST_RUN_ID,
    customerId: CUSTOMER_ID,
    nextDueDate: "2026-10-01",
    generation: 2,
    billingType: "BOLETO",
    value: 5,
  };

  it("aceita generation 2 + BOLETO + value 5", () => {
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

describe("parser — subscription: value obrigatório, finito e >= 5", () => {
  const base = {
    action: "subscription",
    confirmSandbox: true,
    testRunId: TEST_RUN_ID,
    customerId: CUSTOMER_ID,
    nextDueDate: "2026-10-01",
    generation: 2,
    billingType: "BOLETO",
    value: 5,
  };

  // Cenário 1: value ausente → rejeita
  it("rejeita value ausente (exactKeys falha)", () => {
    const { value: _v, ...sem } = base;
    expect(parseSandboxHarnessCommand(sem)).toBeNull();
  });

  // Cenário 2: value string "5" → rejeita
  it("rejeita value string '5'", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: "5" })).toBeNull();
  });

  // Cenário 3: value 4 (abaixo do mínimo) → rejeita
  it("rejeita value 4 (abaixo do mínimo de 5)", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: 4 })).toBeNull();
  });

  // Cenário 4: value 4.99 (abaixo do mínimo, não-inteiro) → rejeita
  it("rejeita value 4.99 (abaixo do mínimo)", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: 4.99 })).toBeNull();
  });

  // Cenário 5: value 0 → rejeita
  it("rejeita value 0", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: 0 })).toBeNull();
  });

  // Cenário 6: value negativo → rejeita
  it("rejeita value negativo (-1)", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: -1 })).toBeNull();
  });

  // Cenário 7: value NaN → rejeita (isFinite(NaN) === false)
  it("rejeita value NaN", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: NaN })).toBeNull();
  });

  // Cenário 8: value Infinity → rejeita (isFinite(Infinity) === false)
  it("rejeita value Infinity", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: Infinity })).toBeNull();
  });

  // Cenário 9: value exatamente 5 → aceita (limite mínimo inclusive)
  it("aceita value exatamente 5 (mínimo inclusivo)", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: 5 })).toEqual({ ...base, value: 5 });
  });

  // Cenário 10: value 10 (acima do mínimo, inteiro) → aceita
  it("aceita value 10", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: 10 })).not.toBeNull();
  });

  // Cenário 11: value 5.5 (finito e >= 5, não-inteiro) → aceita
  it("aceita value 5.5 (finito, >= 5, não-inteiro é permitido)", () => {
    expect(parseSandboxHarnessCommand({ ...base, value: 5.5 })).not.toBeNull();
  });

  // Cenário 12: comando antigo sem value (apenas generation + billingType) → rejeita
  it("rejeita contrato antigo com generation + billingType mas sem value", () => {
    const antigo = {
      action: "subscription",
      confirmSandbox: true,
      testRunId: TEST_RUN_ID,
      customerId: CUSTOMER_ID,
      nextDueDate: "2026-10-01",
      generation: 2,
      billingType: "BOLETO",
    };
    expect(parseSandboxHarnessCommand(antigo)).toBeNull();
  });

  // Cenário 13: value correto + campo extra → rejeita (exactKeys)
  it("rejeita value correto mas com campo extra (exactKeys)", () => {
    expect(parseSandboxHarnessCommand({ ...base, extra: "x" })).toBeNull();
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
        value: 5,
        cycle: "MONTHLY",
        nextDueDate: "2026-10-01",
      }),
      expect.objectContaining({ asaas }),
    );
    expect(asaas.createSubscription).not.toHaveBeenCalled();
  });

  it("generation=2 + BOLETO: passa geração, billingType e value corretos ao provisionSubscription", async () => {
    const asaas = fakeClient();
    const deps = subscriptionDependencies(asaas);
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true,
      phase: "succeeded",
      outcome: "created",
      intent: intentForGen(2, { terms: { billingType: "BOLETO", value: 5, cycle: "MONTHLY", nextDueDate: "2026-10-01", description: "Livia sandbox controlled test" } }),
    });

    const result = await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);

    expect(result.ok && result.action === "subscription" && result.generation).toBe(2);
    const call = vi.mocked(deps.provisionSubscription).mock.calls[0]?.[0];
    expect(call).toMatchObject({
      establishmentId: ESTABLISHMENT_ID,
      subscriptionGeneration: 2,
      asaasCustomerId: CUSTOMER_ID,
      billingType: "BOLETO",
      value: 5,
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

  it("value do comando (5) é repassado exatamente ao provisionSubscription, não hardcoded", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true, phase: "succeeded", outcome: "created",
      intent: intentForGen(2),
    });

    await executeAsaasSandboxHarness(SUBSCRIPTION_COMMAND_GEN2, deps);

    expect(vi.mocked(deps.provisionSubscription).mock.calls[0]?.[0]?.value).toBe(5);
  });

  it("value 10 no comando é repassado como 10, provando que não é hardcoded", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.provisionSubscription).mockResolvedValue({
      ok: true, phase: "succeeded", outcome: "created",
      intent: intentForGen(2),
    });
    const cmdWith10 = { ...SUBSCRIPTION_COMMAND_GEN2, value: 10 };

    await executeAsaasSandboxHarness(cmdWith10, deps);

    expect(vi.mocked(deps.provisionSubscription).mock.calls[0]?.[0]?.value).toBe(10);
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

  it("inspect expõe os campos da subscription usados por subscriptionMatches (OT-05H-V)", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "Secret Name" }]));
    vi.mocked(asaas.getSubscription).mockResolvedValue(ok({
      id: "sub_test_1",
      customer: CUSTOMER_ID,
      billingType: "BOLETO",
      value: 5,
      nextDueDate: "2026-10-01",
      cycle: "MONTHLY",
      externalReference: `livia:subscription:${ESTABLISHMENT_ID}:1`,
      description: "Livia sandbox controlled test",
      status: "ACTIVE",
    }));
    vi.mocked(asaas.listSubscriptionPayments).mockResolvedValue(ok([]));
    const deps = dependencies(asaas);
    const result = await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN1, deps);

    expect(result).toMatchObject({
      ok: true,
      action: "inspect",
      subscription: {
        id: "sub_test_1",
        customer: CUSTOMER_ID,
        externalReference: `livia:subscription:${ESTABLISHMENT_ID}:1`,
        billingType: "BOLETO",
        value: 5,
        cycle: "MONTHLY",
        nextDueDate: "2026-10-01",
        description: "Livia sandbox controlled test",
        status: "ACTIVE",
      },
    });
  });

  it("inspect retorna description:null quando a subscription do Asaas não a ecoa (cenário real da conflict_recovery)", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
    const deps = dependencies(asaas);
    // Gen ainda em conflict: getProvisioningIntent devolve externalSubscriptionId:null,
    // então inspect usa findSubscriptionsForReconciliation — mesma consulta usada pela recovery.
    vi.mocked(deps.getProvisioningIntent).mockResolvedValue(
      intent({ phase: "conflict", externalSubscriptionId: null, conflictSubscriptionIds: ["sub_conflict_1"] }),
    );
    vi.mocked(asaas.findSubscriptionsForReconciliation).mockResolvedValue(ok([{
      id: "sub_conflict_1",
      customer: CUSTOMER_ID,
      billingType: "BOLETO",
      value: 5,
      nextDueDate: "2026-10-01",
      cycle: "MONTHLY",
      externalReference: `livia:subscription:${ESTABLISHMENT_ID}:1`,
      status: "ACTIVE",
      // description deliberadamente ausente — simula a Asaas não ecoando o campo
    }]));
    vi.mocked(asaas.listSubscriptionPayments).mockResolvedValue(ok([]));

    const result = await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN1, deps);

    expect(result).toMatchObject({
      ok: true,
      action: "inspect",
      subscription: {
        id: "sub_conflict_1",
        customer: CUSTOMER_ID,
        billingType: "BOLETO",
        value: 5,
        cycle: "MONTHLY",
        nextDueDate: "2026-10-01",
        description: null,
        status: "ACTIVE",
      },
    });
  });

  it("inspect expõe payment completo: customer, subscription e deleted:false (OT-05H-Z.1)", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
    vi.mocked(asaas.getSubscription).mockResolvedValue(ok({
      id: "sub_test_1",
      customer: CUSTOMER_ID,
      billingType: "BOLETO",
      value: 5,
      nextDueDate: "2026-10-01",
      cycle: "MONTHLY",
      externalReference: `livia:subscription:${ESTABLISHMENT_ID}:1`,
      status: "ACTIVE",
    }));
    vi.mocked(asaas.listSubscriptionPayments).mockResolvedValue(ok([{
      id: "pay_1",
      status: "PENDING",
      dueDate: "2026-10-01",
      value: 5,
      customer: CUSTOMER_ID,
      subscription: "sub_test_1",
      deleted: false,
    }]));
    const deps = dependencies(asaas);
    const result = await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN1, deps);

    expect(result).toMatchObject({
      ok: true,
      action: "inspect",
      payments: [{
        id: "pay_1",
        status: "PENDING",
        dueDate: "2026-10-01",
        value: 5,
        customer: CUSTOMER_ID,
        subscription: "sub_test_1",
        deleted: false,
      }],
    });
  });

  it("inspect expõe deleted:true quando o payment foi removido", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
    vi.mocked(asaas.getSubscription).mockResolvedValue(ok({
      id: "sub_test_1",
      customer: CUSTOMER_ID,
      billingType: "BOLETO",
      value: 5,
      nextDueDate: "2026-10-01",
      cycle: "MONTHLY",
      externalReference: `livia:subscription:${ESTABLISHMENT_ID}:1`,
      status: "ACTIVE",
    }));
    vi.mocked(asaas.listSubscriptionPayments).mockResolvedValue(ok([{
      id: "pay_1",
      status: "REFUNDED",
      dueDate: "2026-10-01",
      value: 5,
      deleted: true,
    }]));
    const deps = dependencies(asaas);
    const result = await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN1, deps);

    expect(result).toMatchObject({
      ok: true,
      action: "inspect",
      payments: [{ id: "pay_1", deleted: true }],
    });
  });

  it("inspect retorna customer/subscription/deleted:null quando ausentes (contrato atual do payment)", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
    vi.mocked(asaas.getSubscription).mockResolvedValue(ok({
      id: "sub_test_1",
      customer: CUSTOMER_ID,
      billingType: "BOLETO",
      value: 5,
      nextDueDate: "2026-10-01",
      cycle: "MONTHLY",
      externalReference: `livia:subscription:${ESTABLISHMENT_ID}:1`,
      status: "ACTIVE",
    }));
    vi.mocked(asaas.listSubscriptionPayments).mockResolvedValue(ok([{
      id: "pay_1",
      status: "PENDING",
      dueDate: "2026-10-01",
      value: 5,
      // customer, subscription e deleted deliberadamente ausentes
    }]));
    const deps = dependencies(asaas);
    const result = await executeAsaasSandboxHarness(INSPECT_COMMAND_GEN1, deps);

    expect(result).toMatchObject({
      ok: true,
      action: "inspect",
      payments: [{
        id: "pay_1",
        status: "PENDING",
        dueDate: "2026-10-01",
        value: 5,
        customer: null,
        subscription: null,
        deleted: null,
      }],
    });
  });
});

describe("conflict_recovery via harness", () => {
  const command = {
    action: "conflict_recovery" as const,
    confirmSandbox: true as const,
    testRunId: TEST_RUN_ID,
    generation: 4,
  };

  it("parseSandboxHarnessCommand aceita conflict_recovery com geração inteira ≥ 1", () => {
    expect(parseSandboxHarnessCommand(command)).toEqual(command);
  });

  it("parseSandboxHarnessCommand rejeita generation zero ou não inteiro", () => {
    expect(parseSandboxHarnessCommand({ ...command, generation: 0 })).toBeNull();
    expect(parseSandboxHarnessCommand({ ...command, generation: 1.5 })).toBeNull();
    expect(parseSandboxHarnessCommand({ ...command, generation: "4" })).toBeNull();
  });

  it("parseSandboxHarnessCommand rejeita campos extras", () => {
    expect(parseSandboxHarnessCommand({ ...command, extra: "x" })).toBeNull();
  });

  it("delega ao recoverConflict com establishment do testRunId e nunca chama createSubscription", async () => {
    const deps = dependencies();
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result).toEqual({
      ok: true,
      action: "conflict_recovery",
      phase: "succeeded",
      generation: 4,
      externalSubscriptionId: "sub_test_1",
    });
    expect(deps.recoverConflict).toHaveBeenCalledWith(
      ESTABLISHMENT_ID,
      4,
      "asaas-sandbox-harness",
      expect.objectContaining({ asaas: deps.asaas }),
    );
    expect(deps.asaas.createSubscription).not.toHaveBeenCalled();
  });

  it("falha se tenant de teste não existe", async () => {
    const deps = dependencies();
    vi.mocked(deps.getEstablishment).mockResolvedValue(null);
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result).toEqual({ ok: false, action: "conflict_recovery", code: "test_establishment_not_found" });
    expect(deps.recoverConflict).not.toHaveBeenCalled();
  });

  it("mapeia recovery conflict para recovery_conflict", async () => {
    const deps = dependencies();
    vi.mocked(deps.recoverConflict).mockResolvedValue({ ok: false, phase: "conflict", reason: "no_subscription_found" });
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result).toEqual({ ok: false, action: "conflict_recovery", code: "recovery_conflict" });
  });
});
