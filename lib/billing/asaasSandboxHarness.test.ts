import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment } from "@/types";
import type { AsaasClient, AsaasResult } from "./asaas";
import type { BillingProvisioningIntent, ProvisioningResult } from "./provisioning";
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

function dependencies(client = fakeClient()): SandboxHarnessDependencies {
  return {
    asaas: client,
    getEstablishment: vi.fn().mockResolvedValue(establishment()),
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

  it("0 existentes cria exatamente um customer fictício e sem notificações", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.createCustomer).mockResolvedValue(ok({ id: CUSTOMER_ID, name: "test" }));
    const result = await executeAsaasSandboxHarness(command, dependencies(asaas));

    expect(result.ok && result.action === "customer" && result.outcome).toBe("created");
    expect(asaas.createCustomer).toHaveBeenCalledTimes(1);
    expect(asaas.createCustomer).toHaveBeenCalledWith({
      name: `Livia Sandbox Test ${TEST_RUN_ID}`,
      cpfCnpj: "12345678901",
      externalReference: sandboxCustomerExternalReference(TEST_RUN_ID),
      notificationDisabled: true,
    });
  });

  it("1 existente reutiliza e faz zero POST", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: CUSTOMER_ID, name: "test" }]));
    const result = await executeAsaasSandboxHarness(command, dependencies(asaas));
    expect(result.ok && result.action === "customer" && result.outcome).toBe("reused");
    expect(asaas.createCustomer).not.toHaveBeenCalled();
  });

  it("N existentes retorna conflito e não escolhe um", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference).mockResolvedValue(ok([
      { id: "cus_1", name: "one" },
      { id: "cus_2", name: "two" },
    ]));
    const result = await executeAsaasSandboxHarness(command, dependencies(asaas));
    expect(result).toEqual({ ok: false, action: "customer", code: "customer_conflict" });
    expect(asaas.createCustomer).not.toHaveBeenCalled();
  });

  it("timeout reconcilia por GET e nunca repete o POST", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference)
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([{ id: CUSTOMER_ID, name: "test" }]));
    vi.mocked(asaas.createCustomer).mockResolvedValue({
      ok: false,
      error: { kind: "timeout", message: "safe" },
    });
    const result = await executeAsaasSandboxHarness(command, dependencies(asaas));
    expect(result.ok && result.action === "customer" && result.outcome).toBe("reconciled");
    expect(asaas.createCustomer).toHaveBeenCalledTimes(1);
    expect(asaas.findCustomersByExternalReference).toHaveBeenCalledTimes(2);
  });

  it("timeout ainda sem resultado retorna reconciling; replay continua sem duplicar quando o GET encontra", async () => {
    const asaas = fakeClient();
    vi.mocked(asaas.findCustomersByExternalReference)
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([{ id: CUSTOMER_ID, name: "test" }]));
    vi.mocked(asaas.createCustomer).mockResolvedValue({
      ok: false,
      error: { kind: "network", message: "safe" },
    });
    const deps = dependencies(asaas);
    const first = await executeAsaasSandboxHarness(command, deps);
    const replay = await executeAsaasSandboxHarness(command, deps);
    expect(first.ok && first.action === "customer" && first.outcome).toBe("reconciling");
    expect(replay.ok && replay.action === "customer" && replay.outcome).toBe("reused");
    expect(asaas.createCustomer).toHaveBeenCalledTimes(1);
  });
});

describe("subscription pelo workflow durável", () => {
  const command = {
    action: "subscription" as const,
    confirmSandbox: true as const,
    testRunId: TEST_RUN_ID,
    customerId: CUSTOMER_ID,
    nextDueDate: "2026-10-01",
  };

  it("usa generation=1, PIX/MONTHLY/R$1 e nunca chama createSubscription diretamente", async () => {
    const asaas = fakeClient();
    const deps = subscriptionDependencies(asaas);
    const result = await executeAsaasSandboxHarness(command, deps);

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

  it("replay usa a mesma identidade lógica e deixa idempotência para o workflow", async () => {
    const deps = subscriptionDependencies();
    await executeAsaasSandboxHarness(command, deps);
    await executeAsaasSandboxHarness(command, deps);
    expect(deps.provisionSubscription).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.provisionSubscription).mock.calls[0]?.[0]).toEqual(
      vi.mocked(deps.provisionSubscription).mock.calls[1]?.[0],
    );
  });

  it("não cria tenant de teste e falha se ele não existir", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.getEstablishment).mockResolvedValue(null);
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result).toEqual({ ok: false, action: "subscription", code: "test_establishment_not_found" });
    expect(deps.provisionSubscription).not.toHaveBeenCalled();
  });

  it("falha fechado se id ou owner do tenant dedicado divergirem", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.getEstablishment).mockResolvedValue(establishment({ ownerUid: "real-owner" }));
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result).toEqual({ ok: false, action: "subscription", code: "test_establishment_invalid" });
    expect(deps.provisionSubscription).not.toHaveBeenCalled();
  });

  it("rejeita customer que não pertence ao externalReference determinístico do run", async () => {
    const deps = subscriptionDependencies();
    vi.mocked(deps.asaas.findCustomersByExternalReference).mockResolvedValue(ok([{ id: "cus_other", name: "other" }]));
    const result = await executeAsaasSandboxHarness(command, deps);
    expect(result).toEqual({ ok: false, action: "subscription", code: "customer_conflict" });
    expect(deps.provisionSubscription).not.toHaveBeenCalled();
  });
});

describe("inspect somente leitura e respostas sanitizadas", () => {
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
    const result = await executeAsaasSandboxHarness({
      action: "inspect",
      confirmSandbox: true,
      testRunId: TEST_RUN_ID,
      customerId: CUSTOMER_ID,
    }, deps);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Secret Name");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(asaas.createCustomer).not.toHaveBeenCalled();
    expect(asaas.createSubscription).not.toHaveBeenCalled();
    expect(deps.provisionSubscription).not.toHaveBeenCalled();
  });
});
