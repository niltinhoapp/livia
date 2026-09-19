import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import type { AsaasClient, AsaasError, AsaasPayment, AsaasSubscription, CreateSubscriptionInput } from "./asaas";
import {
  getBillingProvisioningIntent,
  logicalSubscriptionExternalReference,
  provisionAsaasSubscription,
  reconcileConflictedSubscription,
  subscriptionFingerprint,
  type ConflictRecoveryDependencies,
  type ProvisionSubscriptionInput,
  type ProvisioningDependencies,
} from "./provisioning";

const INPUT: ProvisionSubscriptionInput = {
  establishmentId: "est_1",
  subscriptionGeneration: 1,
  asaasCustomerId: "cus_1",
  leaseOwner: "worker_1",
  billingType: "PIX",
  value: 99.9,
  cycle: "MONTHLY",
  nextDueDate: "2026-09-22",
};

function matchingSubscription(
  patch: Partial<AsaasSubscription> = {},
): AsaasSubscription {
  return {
    id: "sub_1",
    customer: INPUT.asaasCustomerId,
    billingType: INPUT.billingType,
    value: INPUT.value,
    cycle: INPUT.cycle,
    nextDueDate: INPUT.nextDueDate,
    externalReference: logicalSubscriptionExternalReference(
      INPUT.establishmentId,
      INPUT.subscriptionGeneration,
    ),
    status: "ACTIVE", // representa uma subscription genuinamente reutilizável por padrão; testes de status inativo sobrescrevem isto explicitamente
    ...patch,
  };
}

type ReconciliationClient = Pick<
  AsaasClient,
  "createSubscription" | "getSubscription" | "findSubscriptionsForReconciliation" | "listSubscriptionPayments"
>;

function fakeAsaas(overrides: Partial<ReconciliationClient> = {}): ReconciliationClient {
  return {
    createSubscription: vi.fn(async (input: CreateSubscriptionInput) => ({
      ok: true as const,
      data: matchingSubscription({
        customer: input.customer,
        billingType: input.billingType,
        value: input.value,
        cycle: input.cycle,
        nextDueDate: input.nextDueDate,
        description: input.description,
        externalReference: input.externalReference,
      }),
    })),
    getSubscription: vi.fn(async () => ({ ok: true as const, data: matchingSubscription() })),
    findSubscriptionsForReconciliation: vi.fn(async () => ({ ok: true as const, data: [] })),
    listSubscriptionPayments: vi.fn(async () => ({ ok: true as const, data: [] })),
    ...overrides,
  };
}

function dependencies(
  asaas: ReconciliationClient,
  options: Partial<Omit<ProvisioningDependencies, "asaas">> = {},
): ProvisioningDependencies {
  let id = 0;
  return {
    asaas,
    now: () => 1_000,
    newId: () => `id_${++id}`,
    ...options,
  };
}

function asaasFailure(kind: AsaasError["kind"], status?: number) {
  return {
    ok: false as const,
    error: {
      kind,
      ...(status !== undefined ? { status } : {}),
      message: "sanitized",
    } satisfies AsaasError,
  };
}

beforeEach(() => {
  fakeDb.reset();
});

describe("identidade lógica e fingerprint", () => {
  it("usa establishment + generation sem variar entre retries", () => {
    expect(logicalSubscriptionExternalReference("est_1", 1)).toBe("livia:subscription:est_1:1");
    expect(logicalSubscriptionExternalReference("est_1", 2)).toBe("livia:subscription:est_1:2");
  });

  it("mesma intenção produz o mesmo fingerprint", () => {
    const terms = { billingType: "PIX" as const, value: 99.9, cycle: "MONTHLY" as const, nextDueDate: "2026-09-22" };
    expect(subscriptionFingerprint(terms)).toBe(subscriptionFingerprint({ ...terms }));
  });

  it.each([
    ["value", { value: 100 }],
    ["cycle", { cycle: "YEARLY" as const }],
    ["nextDueDate", { nextDueDate: "2026-09-23" }],
    ["description", { description: "outro plano" }],
  ])("mudança em %s altera o fingerprint", (_field, patch) => {
    const terms = { billingType: "PIX" as const, value: 99.9, cycle: "MONTHLY" as const, nextDueDate: "2026-09-22" };
    expect(subscriptionFingerprint({ ...terms, ...patch })).not.toBe(subscriptionFingerprint(terms));
  });
});

describe("intent durável e protocolo normal", () => {
  it("primeira execução reserva e conclui a intent determinística", async () => {
    const client = fakeAsaas();
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    const stored = await getBillingProvisioningIntent("est_1", 1);
    expect(result.ok && result.outcome).toBe("created");
    expect(stored).toMatchObject({
      operationId: "est_1:1",
      subscriptionGeneration: 1,
      phase: "succeeded",
      externalSubscriptionId: "sub_1",
    });
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("replay idêntico usa GET pelo ID e nunca repete POST/listagem", async () => {
    const client = fakeAsaas();
    await provisionAsaasSubscription(INPUT, dependencies(client));
    vi.mocked(client.createSubscription).mockClear();
    vi.mocked(client.findSubscriptionsForReconciliation).mockClear();
    const replay = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(replay.ok && replay.outcome).toBe("verified");
    expect(client.getSubscription).toHaveBeenCalledWith("sub_1");
    expect(client.findSubscriptionsForReconciliation).not.toHaveBeenCalled();
    expect(client.createSubscription).not.toHaveBeenCalled();
  });

  it("mesma geração com fingerprint diferente falha fechado", async () => {
    const client = fakeAsaas();
    await provisionAsaasSubscription(INPUT, dependencies(client));
    vi.mocked(client.createSubscription).mockClear();
    const conflict = await provisionAsaasSubscription({ ...INPUT, value: 101 }, dependencies(client));
    expect(conflict).toMatchObject({ ok: false, phase: "conflict", reason: "identity_conflict" });
    expect(client.createSubscription).not.toHaveBeenCalled();
  });

  it("subscription existente compatível é reconciliada sem POST", async () => {
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => ({ ok: true as const, data: [matchingSubscription()] })),
    });
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(result.ok && result.outcome).toBe("reconciled");
    expect(client.createSubscription).not.toHaveBeenCalled();
    expect((await getBillingProvisioningIntent("est_1", 1))?.externalSubscriptionId).toBe("sub_1");
  });

  it("subscription existente incompatível vira conflict e não faz POST", async () => {
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingSubscription({ value: 500 })],
      })),
    });
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "subscription_mismatch" });
    expect(client.createSubscription).not.toHaveBeenCalled();
  });

  it("subscription existente com campos batendo mas status INACTIVE (cancelada) nunca é reutilizada", async () => {
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingSubscription({ status: "INACTIVE" })],
      })),
    });
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "subscription_inactive" });
    expect(client.createSubscription).not.toHaveBeenCalled();
    expect((await getBillingProvisioningIntent("est_1", 1))?.externalSubscriptionId).toBeNull();
  });

  it("subscription existente sem status algum também é rejeitada (fail-closed, nunca assume ACTIVE por ausência)", async () => {
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingSubscription({ status: undefined })],
      })),
    });
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "subscription_inactive" });
  });

  it("ID persistido divergente vira conflict após GET por ID", async () => {
    const initial = fakeAsaas();
    await provisionAsaasSubscription(INPUT, dependencies(initial));
    const client = fakeAsaas({
      getSubscription: vi.fn(async () => ({ ok: true as const, data: matchingSubscription({ customer: "cus_other" }) })),
    });
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(client.getSubscription).toHaveBeenCalledWith("sub_1");
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "known_subscription_mismatch" });
    expect(client.createSubscription).not.toHaveBeenCalled();
  });

  it("ID persistido aponta pra subscription cancelada (INACTIVE) no Asaas: nunca é 'verified'", async () => {
    // Cenário real do diagnóstico de recontratação pós-cancelamento: o
    // establishment está billingStatus="canceled" mas o intent gen=1 ainda
    // guarda externalSubscriptionId da subscription real, que a Asaas já
    // marcou INACTIVE (SUBSCRIPTION_DELETED). Os campos continuam batendo
    // (subscriptionMatches sozinho diria "verified") — só o status a
    // distingue de uma subscription genuinamente ativa.
    const initial = fakeAsaas();
    await provisionAsaasSubscription(INPUT, dependencies(initial));
    const client = fakeAsaas({
      getSubscription: vi.fn(async () => ({ ok: true as const, data: matchingSubscription({ status: "INACTIVE" }) })),
    });
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "known_subscription_inactive" });
    expect(client.createSubscription).not.toHaveBeenCalled();
  });

  it("falha inconclusiva no GET por ID persiste reconciling sem novo POST", async () => {
    const initial = fakeAsaas();
    await provisionAsaasSubscription(INPUT, dependencies(initial));
    const client = fakeAsaas({ getSubscription: vi.fn(async () => asaasFailure("network")) });
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: true, phase: "reconciling", outcome: "lookup_failed" });
    expect((await getBillingProvisioningIntent("est_1", 1))?.phase).toBe("reconciling");
    expect(client.createSubscription).not.toHaveBeenCalled();
  });
});

describe("duplicatas e informação operacional", () => {
  it("múltiplas subscriptions viram conflict, consultam payments e geram zero POSTs", async () => {
    const duplicates = [matchingSubscription(), matchingSubscription({ id: "sub_2" })];
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => ({ ok: true as const, data: duplicates })),
      listSubscriptionPayments: vi.fn(async (id) => ({
        ok: true as const,
        data: id === "sub_1" ? [{ id: "pay_1" }] : [],
      })),
    });
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    const stored = await getBillingProvisioningIntent("est_1", 1);
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "multiple_subscriptions" });
    expect(client.listSubscriptionPayments).toHaveBeenCalledTimes(2);
    expect(client.createSubscription).not.toHaveBeenCalled();
    expect(stored).toMatchObject({
      conflictSubscriptionIds: ["sub_1", "sub_2"],
      conflictPaymentCounts: { sub_1: 1, sub_2: 0 },
    });
  });
});

describe("falhas inconclusivas e recuperação de crash", () => {
  it.each(["timeout", "network", "invalid_response"] as const)(
    "%s após o POST entra em reconciling e nunca faz retry automático",
    async (kind) => {
      const client = fakeAsaas({ createSubscription: vi.fn(async () => asaasFailure(kind)) });
      const first = await provisionAsaasSubscription(INPUT, dependencies(client));
      const second = await provisionAsaasSubscription(INPUT, dependencies(client));
      expect(first).toMatchObject({ ok: true, phase: "reconciling", outcome: "awaiting_reconciliation" });
      expect(second).toMatchObject({ ok: true, phase: "reconciling", outcome: "awaiting_reconciliation" });
      expect(client.createSubscription).toHaveBeenCalledTimes(1);
    },
  );

  it("timeout com criação remota simulada é recuperado no restart", async () => {
    let remote: AsaasSubscription[] = [];
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => {
        remote = [matchingSubscription()];
        return asaasFailure("timeout");
      }),
      findSubscriptionsForReconciliation: vi.fn(async () => ({ ok: true as const, data: remote })),
    });
    await provisionAsaasSubscription(INPUT, dependencies(client));
    const recovered = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(recovered.ok && recovered.outcome).toBe("reconciled");
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("crash antes de marcar creating deixa reserved retomável depois do lease", async () => {
    let now = 1_000;
    let ids = 0;
    const client = fakeAsaas();
    const crashingDeps = dependencies(client, {
      now: () => now,
      newId: () => {
        ids += 1;
        if (ids === 2) throw new Error("crash before creating");
        return `id_${ids}`;
      },
    });
    await expect(provisionAsaasSubscription(INPUT, crashingDeps)).rejects.toThrow("crash before creating");
    expect((await getBillingProvisioningIntent("est_1", 1))?.phase).toBe("reserved");
    expect(client.createSubscription).not.toHaveBeenCalled();

    now = 32_000;
    const resumed = await provisionAsaasSubscription(INPUT, dependencies(client, { now: () => now }));
    expect(resumed.ok && resumed.outcome).toBe("created");
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("crash após POST e antes da persistência é recuperado por lookup", async () => {
    let now = 1_000;
    let remote: AsaasSubscription[] = [];
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => {
        remote = [matchingSubscription()];
        return { ok: true as const, data: remote[0]! };
      }),
      findSubscriptionsForReconciliation: vi.fn(async () => ({ ok: true as const, data: remote })),
    });
    await expect(provisionAsaasSubscription(INPUT, dependencies(client, {
      now: () => now,
      afterCreateSubscription: () => { throw new Error("crash after POST"); },
    }))).rejects.toThrow("crash after POST");
    expect((await getBillingProvisioningIntent("est_1", 1))?.phase).toBe("creating");

    now = 32_000;
    const recovered = await provisionAsaasSubscription(INPUT, dependencies(client, { now: () => now }));
    expect(recovered.ok && recovered.outcome).toBe("reconciled");
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("lease expirado em creating com lookup vazio não autoriza outro POST", async () => {
    let now = 1_000;
    const client = fakeAsaas();
    await expect(provisionAsaasSubscription(INPUT, dependencies(client, {
      now: () => now,
      afterCreateSubscription: () => { throw new Error("crash"); },
    }))).rejects.toThrow("crash");
    now = 32_000;
    vi.mocked(client.createSubscription).mockClear();
    const result = await provisionAsaasSubscription(INPUT, dependencies(client, { now: () => now }));
    expect(result).toMatchObject({ ok: true, phase: "reconciling", outcome: "awaiting_reconciliation" });
    expect(client.createSubscription).not.toHaveBeenCalled();
  });

  it("HTTP 400 conclusivo vira failed_terminal; HTTP 500 permanece inconclusivo", async () => {
    const rejected = fakeAsaas({ createSubscription: vi.fn(async () => asaasFailure("http", 400)) });
    expect(await provisionAsaasSubscription(INPUT, dependencies(rejected))).toMatchObject({
      ok: false, phase: "failed_terminal", reason: "asaas_rejected",
    });
    fakeDb.reset();
    const uncertain = fakeAsaas({ createSubscription: vi.fn(async () => asaasFailure("http", 500)) });
    expect(await provisionAsaasSubscription(INPUT, dependencies(uncertain))).toMatchObject({
      ok: true, phase: "reconciling", outcome: "awaiting_reconciliation",
    });
  });
});

describe("concorrência e transaction retry", () => {
  it("duas execuções concorrentes concedem direito de POST a apenas uma", async () => {
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => {
        lookupStarted();
        await blocked;
        return { ok: true as const, data: [] };
      }),
    });
    const first = provisionAsaasSubscription(INPUT, dependencies(client));
    await started;
    const second = await provisionAsaasSubscription({ ...INPUT, leaseOwner: "worker_2" }, dependencies(client));
    expect(second.ok && second.outcome).toBe("busy");
    releaseLookup();
    const winner = await first;
    expect(winner.ok && winner.outcome).toBe("created");
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("recontratação (generation=2): duas execuções concorrentes para a MESMA geração nova convergem numa única subscription", async () => {
    // Prova o invariante central da OT de recontratação: duas requisições
    // simultâneas de um tenant "canceled" — ambas já teriam calculado a
    // mesma subscriptionGeneration alvo (resolveTargetGeneration, em
    // app/api/billing/subscribe/route.ts, lê o valor persistido, não
    // incrementa cegamente) — nunca criam duas subscriptions na mesma
    // geração. Mesmo mecanismo de lease/reserveIntent já testado acima para
    // generation=1, aqui confirmado explicitamente para generation=2.
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => {
        lookupStarted();
        await blocked;
        return { ok: true as const, data: [] };
      }),
    });
    const recontratacaoInput = { ...INPUT, subscriptionGeneration: 2 };
    const first = provisionAsaasSubscription(recontratacaoInput, dependencies(client));
    await started;
    const second = await provisionAsaasSubscription({ ...recontratacaoInput, leaseOwner: "worker_2" }, dependencies(client));
    expect(second.ok && second.outcome).toBe("busy");
    releaseLookup();
    const winner = await first;
    expect(winner.ok && winner.outcome).toBe("created");
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
    expect((await getBillingProvisioningIntent("est_1", 2))?.externalReference).toBe(
      logicalSubscriptionExternalReference("est_1", 2),
    );
    // A geração antiga (1) nunca é tocada por essa recontratação.
    expect(await getBillingProvisioningIntent("est_1", 1)).toBeNull();
  });

  it("retry da callback Firestore não duplica POST", async () => {
    fakeDb.retryNextTransaction(1);
    const client = fakeAsaas();
    const result = await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(result.ok && result.outcome).toBe("created");
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("nenhuma chamada Asaas ocorre enquanto uma transaction está ativa", async () => {
    const assertOutsideTransaction = () => expect(fakeDb.isTransactionActive()).toBe(false);
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => {
        assertOutsideTransaction();
        return { ok: true as const, data: [] };
      }),
      createSubscription: vi.fn(async () => {
        assertOutsideTransaction();
        return { ok: true as const, data: matchingSubscription() };
      }),
    });
    await provisionAsaasSubscription(INPUT, dependencies(client));
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });
});

describe("lastError descriptions", () => {
  it("HTTP 400 com description preserva codes e descriptions no lastError", async () => {
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "http" as const,
          status: 400,
          errors: [{ code: "invalid_value", description: "mensagem de validação" }],
          message: "Asaas: requisição falhou (HTTP 400).",
        } satisfies AsaasError,
      })),
    });
    await provisionAsaasSubscription(INPUT, dependencies(client));
    const stored = await getBillingProvisioningIntent("est_1", 1);
    expect(stored?.phase).toBe("failed_terminal");
    expect(stored?.lastError).toEqual({
      kind: "http",
      status: 400,
      codes: ["invalid_value"],
      descriptions: ["mensagem de validação"],
    });
  });

  it("múltiplos errors preservam todos os codes e descriptions na ordem original", async () => {
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "http" as const,
          status: 422,
          errors: [
            { code: "invalid_value", description: "O campo value é inválido" },
            { code: "invalid_field", description: "O campo nextDueDate é inválido" },
          ],
          message: "Asaas: requisição falhou (HTTP 422).",
        } satisfies AsaasError,
      })),
    });
    await provisionAsaasSubscription(INPUT, dependencies(client));
    const stored = await getBillingProvisioningIntent("est_1", 1);
    expect(stored?.lastError).toMatchObject({
      codes: ["invalid_value", "invalid_field"],
      descriptions: ["O campo value é inválido", "O campo nextDueDate é inválido"],
    });
  });

  it("description ausente em todos os errors omite descriptions do lastError", async () => {
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "http" as const,
          status: 400,
          errors: [{ code: "invalid_value" }],
          message: "Asaas: requisição falhou (HTTP 400).",
        } satisfies AsaasError,
      })),
    });
    await provisionAsaasSubscription(INPUT, dependencies(client));
    const stored = await getBillingProvisioningIntent("est_1", 1);
    expect(stored?.lastError).toEqual({
      kind: "http",
      status: 400,
      codes: ["invalid_value"],
    });
    expect(stored?.lastError).not.toHaveProperty("descriptions");
  });
});

describe("subscriptionMatches — description ausente na resposta Asaas (OT-05H-P)", () => {
  const descInput: ProvisionSubscriptionInput = { ...INPUT, description: "Livia sandbox controlled test" };

  function noDescClient(extraPatch: Partial<AsaasSubscription> = {}): ReconciliationClient {
    return fakeAsaas({
      createSubscription: vi.fn(async (input: CreateSubscriptionInput) => ({
        ok: true as const,
        data: matchingSubscription({
          customer: input.customer,
          billingType: input.billingType,
          value: input.value,
          cycle: input.cycle,
          nextDueDate: input.nextDueDate,
          externalReference: input.externalReference,
          ...extraPatch,
          // description deliberadamente ausente — simula Asaas não ecoando
        }),
      })),
    });
  }

  it("response sem description não dispara conflict quando intent tem description", async () => {
    const client = noDescClient();
    const result = await provisionAsaasSubscription(descInput, dependencies(client));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "created" });
    expect((await getBillingProvisioningIntent("est_1", 1))?.externalSubscriptionId).toBe("sub_1");
  });

  it("response com description diferente da intent ainda dispara created_subscription_mismatch", async () => {
    const client = fakeAsaas({
      createSubscription: vi.fn(async (input: CreateSubscriptionInput) => ({
        ok: true as const,
        data: matchingSubscription({
          customer: input.customer, billingType: input.billingType, value: input.value,
          cycle: input.cycle, nextDueDate: input.nextDueDate, externalReference: input.externalReference,
          description: "description completamente diferente",
        }),
      })),
    });
    const result = await provisionAsaasSubscription(descInput, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "created_subscription_mismatch" });
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("response com description igual à intent é aceita normalmente", async () => {
    const client = fakeAsaas({
      createSubscription: vi.fn(async (input: CreateSubscriptionInput) => ({
        ok: true as const,
        data: matchingSubscription({
          customer: input.customer, billingType: input.billingType, value: input.value,
          cycle: input.cycle, nextDueDate: input.nextDueDate, externalReference: input.externalReference,
          description: "Livia sandbox controlled test",
        }),
      })),
    });
    const result = await provisionAsaasSubscription(descInput, dependencies(client));
    expect(result).toMatchObject({ ok: true, phase: "succeeded" });
  });

  it("divergência em billingType continua disparando created_subscription_mismatch independente da description", async () => {
    const client = noDescClient({ billingType: "BOLETO" });
    const result = await provisionAsaasSubscription(descInput, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "created_subscription_mismatch" });
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("phase conflict pré-existente impede POST em qualquer replay subsequente", async () => {
    await provisionAsaasSubscription(descInput, dependencies(noDescClient({ billingType: "BOLETO" })));
    expect((await getBillingProvisioningIntent("est_1", 1))?.phase).toBe("conflict");
    const replayClient = noDescClient();
    const replay = await provisionAsaasSubscription(descInput, dependencies(replayClient));
    expect(replay).toMatchObject({ ok: false, phase: "conflict" });
    expect(replayClient.createSubscription).not.toHaveBeenCalled();
  });

  it("reconciliation: subscription encontrada sem description + intent com description → reconciliada sem POST", async () => {
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingSubscription()],
      })),
    });
    const result = await provisionAsaasSubscription(descInput, dependencies(client));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "reconciled" });
    expect(client.createSubscription).not.toHaveBeenCalled();
    expect((await getBillingProvisioningIntent("est_1", 1))?.externalSubscriptionId).toBe("sub_1");
  });

  it("fingerprint diferente em description continua disparando identity_conflict", async () => {
    const client = noDescClient();
    await provisionAsaasSubscription(descInput, dependencies(client));
    vi.mocked(client.createSubscription).mockClear();
    const result = await provisionAsaasSubscription({ ...descInput, description: "outro plano" }, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "identity_conflict" });
    expect(client.createSubscription).not.toHaveBeenCalled();
  });
});

describe("segurança da persistência", () => {
  it("não persiste AsaasError.message, cartão ou payload HTTP bruto; persiste descriptions do errors[]", async () => {
    const secret = "$aact_hmlg_SECRET_SHOULD_NOT_PERSIST";
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "http" as const,
          status: 500,
          // description vem do corpo estruturado do Asaas (campo seguro — não ecoa
          // dados de request) e agora é persistida como parte de descriptions[].
          errors: [{ code: "server_error", description: "erro interno de validação" }],
          // message é nossa própria string sintetizada e NUNCA deve ser persistida.
          message: secret,
        },
      })),
    });
    await provisionAsaasSubscription(INPUT, dependencies(client));
    const serialized = JSON.stringify(await getBillingProvisioningIntent("est_1", 1));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/creditCard|access_token|cookie|cvv|pan/i);
    expect(serialized).toContain("server_error");
    expect(serialized).toContain("erro interno de validação");
  });
});

describe("reconcileConflictedSubscription", () => {
  const RECOVERY_EST = "est_recovery";
  const RECOVERY_GEN = 2;
  const CONFLICT_SUB_ID = "sub_conflict_1";

  const RECOVERY_INPUT: ProvisionSubscriptionInput = {
    ...INPUT,
    establishmentId: RECOVERY_EST,
    subscriptionGeneration: RECOVERY_GEN,
    description: "Livia sandbox controlled test",
  };

  function matchingRecoverySubscription(patch: Partial<AsaasSubscription> = {}): AsaasSubscription {
    return {
      id: CONFLICT_SUB_ID,
      customer: RECOVERY_INPUT.asaasCustomerId,
      billingType: RECOVERY_INPUT.billingType,
      value: RECOVERY_INPUT.value,
      cycle: RECOVERY_INPUT.cycle,
      nextDueDate: RECOVERY_INPUT.nextDueDate,
      externalReference: logicalSubscriptionExternalReference(RECOVERY_EST, RECOVERY_GEN),
      status: "ACTIVE",
      ...patch,
    };
  }

  type ConflictClient = Pick<
    AsaasClient,
    "getSubscription" | "findSubscriptionsForReconciliation" | "listSubscriptionPayments"
  >;

  function fakeConflictClient(overrides: Partial<ConflictClient> = {}): ConflictClient {
    return {
      getSubscription: vi.fn(async () => ({ ok: true as const, data: matchingRecoverySubscription() })),
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingRecoverySubscription()],
      })),
      listSubscriptionPayments: vi.fn(async () => ({ ok: true as const, data: [] })),
      ...overrides,
    };
  }

  function recoveryDeps(asaas: ConflictClient, now = () => 1_000): ConflictRecoveryDependencies {
    let id = 0;
    return { asaas, now, newId: () => `recovery_id_${++id}`, leaseDurationMs: 30_000 };
  }

  // Creates a conflict state: createSubscription returns billingType "BOLETO" (simulating
  // a buggy Asaas response), triggering created_subscription_mismatch for CONFLICT_SUB_ID.
  async function setupConflictState(): Promise<void> {
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => ({
        ok: true as const,
        data: matchingRecoverySubscription({ billingType: "BOLETO" }),
      })),
    });
    const result = await provisionAsaasSubscription(RECOVERY_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict" });
    expect((await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN))?.conflictSubscriptionIds).toEqual([CONFLICT_SUB_ID]);
  }

  // 1
  it("retorna intent_not_found se intent não existe no Firestore", async () => {
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(fakeConflictClient()));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "intent_not_found" });
  });

  // 2
  it("retorna not_recoverable se phase é failed_terminal", async () => {
    await provisionAsaasSubscription(
      RECOVERY_INPUT,
      dependencies(fakeAsaas({ createSubscription: vi.fn(async () => asaasFailure("http", 400)) })),
    );
    expect((await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN))?.phase).toBe("failed_terminal");
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(fakeConflictClient()));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "not_recoverable" });
  });

  // 3
  it("retorna ok:true/verified se phase já é succeeded", async () => {
    await provisionAsaasSubscription(RECOVERY_INPUT, dependencies(fakeAsaas()));
    expect((await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN))?.phase).toBe("succeeded");
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(fakeConflictClient()));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "verified" });
  });

  // 4
  it("retorna not_recoverable se conflictSubscriptionIds.length > 1", async () => {
    const client = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingRecoverySubscription({ id: "sub_r1" }), matchingRecoverySubscription({ id: "sub_r2" })],
      })),
      listSubscriptionPayments: vi.fn(async () => ({ ok: true as const, data: [] })),
    });
    await provisionAsaasSubscription(RECOVERY_INPUT, dependencies(client));
    const stored = await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN);
    expect(stored?.conflictSubscriptionIds?.length).toBe(2);
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(fakeConflictClient()));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "not_recoverable" });
  });

  // 5
  it("retorna busy_or_not_recoverable quando lease ativo existe", async () => {
    await setupConflictState();
    let leaseAcquired!: () => void;
    let release!: () => void;
    const leased = new Promise<void>((r) => { leaseAcquired = r; });
    const blocked = new Promise<void>((r) => { release = r; });
    const slowClient: ConflictClient = {
      getSubscription: vi.fn(),
      listSubscriptionPayments: vi.fn(),
      findSubscriptionsForReconciliation: vi.fn(async () => {
        leaseAcquired();
        await blocked;
        return { ok: true as const, data: [matchingRecoverySubscription()] };
      }),
    };
    const first = reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker_a", recoveryDeps(slowClient));
    await leased;
    const second = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker_b", recoveryDeps(slowClient));
    expect(second).toMatchObject({ ok: false, phase: "conflict", reason: "busy_or_not_recoverable" });
    release();
    await first;
  });

  // 6
  it("retorna lookup_failed quando API retorna erro e libera o lease", async () => {
    await setupConflictState();
    const errorClient: ConflictClient = {
      getSubscription: vi.fn(),
      listSubscriptionPayments: vi.fn(),
      findSubscriptionsForReconciliation: vi.fn(async () => asaasFailure("network")),
    };
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(errorClient));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "lookup_failed" });
    const stored = await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN);
    expect(stored?.phase).toBe("conflict");
    expect(stored?.leaseId).toBeNull();
  });

  // 7
  it("retorna no_subscription_found quando lookup retorna vazio e libera lease", async () => {
    await setupConflictState();
    const emptyClient: ConflictClient = {
      getSubscription: vi.fn(),
      listSubscriptionPayments: vi.fn(),
      findSubscriptionsForReconciliation: vi.fn(async () => ({ ok: true as const, data: [] })),
    };
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(emptyClient));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "no_subscription_found" });
    expect((await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN))?.leaseId).toBeNull();
  });

  // 8
  it("retorna multiple_subscriptions quando lookup retorna >1 e atualiza conflictSubscriptionIds", async () => {
    await setupConflictState();
    const multiClient: ConflictClient = {
      getSubscription: vi.fn(),
      listSubscriptionPayments: vi.fn(),
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingRecoverySubscription({ id: "sub_new_1" }), matchingRecoverySubscription({ id: "sub_new_2" })],
      })),
    };
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(multiClient));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "multiple_subscriptions" });
    const stored = await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN);
    expect(stored?.conflictSubscriptionIds).toEqual(["sub_new_1", "sub_new_2"]);
  });

  // 9
  it("retorna conflict_id_mismatch quando found.id != conflictSubscriptionIds[0]", async () => {
    await setupConflictState();
    const mismatchIdClient: ConflictClient = {
      getSubscription: vi.fn(),
      listSubscriptionPayments: vi.fn(),
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingRecoverySubscription({ id: "sub_completely_different" })],
      })),
    };
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(mismatchIdClient));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "conflict_id_mismatch" });
  });

  // 10
  it("retorna subscription_not_active quando status é CANCELLED", async () => {
    await setupConflictState();
    const cancelledClient: ConflictClient = {
      getSubscription: vi.fn(),
      listSubscriptionPayments: vi.fn(),
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingRecoverySubscription({ status: "CANCELLED" })],
      })),
    };
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(cancelledClient));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "subscription_not_active" });
    expect((await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN))?.phase).toBe("conflict");
  });

  // 11
  it("retorna subscription_not_active quando status está ausente (undefined)", async () => {
    await setupConflictState();
    const noStatusClient: ConflictClient = {
      getSubscription: vi.fn(),
      listSubscriptionPayments: vi.fn(),
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingRecoverySubscription({ status: undefined })],
      })),
    };
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(noStatusClient));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "subscription_not_active" });
  });

  // 12
  it("retorna subscription_mismatch quando subscriptionMatches falha", async () => {
    await setupConflictState();
    const mismatchFieldClient: ConflictClient = {
      getSubscription: vi.fn(),
      listSubscriptionPayments: vi.fn(),
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingRecoverySubscription({ billingType: "BOLETO", status: "ACTIVE" })],
      })),
    };
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(mismatchFieldClient));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "subscription_mismatch" });
    expect((await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN))?.phase).toBe("conflict");
  });

  // 13
  it("happy path: promove para succeeded com externalSubscriptionId correto", async () => {
    await setupConflictState();
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(fakeConflictClient()));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "reconciled" });
    const stored = await getBillingProvisioningIntent(RECOVERY_EST, RECOVERY_GEN);
    expect(stored?.phase).toBe("succeeded");
    expect(stored?.externalSubscriptionId).toBe(CONFLICT_SUB_ID);
    expect(stored?.leaseId).toBeNull();
  });

  // 14
  it("segunda chamada após reconciliação retorna verified sem nova chamada à API", async () => {
    await setupConflictState();
    await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(fakeConflictClient()));
    const secondClient = fakeConflictClient();
    const second = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(secondClient));
    expect(second).toMatchObject({ ok: true, phase: "succeeded", outcome: "verified" });
    expect(secondClient.findSubscriptionsForReconciliation).not.toHaveBeenCalled();
  });

  it("nextDueDate igual: promove sem nunca chamar listSubscriptionPayments", async () => {
    await setupConflictState();
    const client = fakeConflictClient();
    const result = await reconcileConflictedSubscription(RECOVERY_EST, RECOVERY_GEN, "worker", recoveryDeps(client));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "reconciled" });
    expect(client.listSubscriptionPayments).not.toHaveBeenCalled();
  });

  it("ConflictRecoveryClient nunca expõe createSubscription (garantia estrutural)", () => {
    const client = fakeConflictClient();
    expect("createSubscription" in client).toBe(false);
  });
});

describe("reconcileConflictedSubscription — recovery temporal de nextDueDate (OT-05H-Z)", () => {
  const TEMPORAL_EST = "est_temporal";
  const TEMPORAL_GEN = 4;
  const TEMPORAL_SUB_ID = "sub_kq0ax6txhhbovblg"; // mesmo formato do caso real da gen4

  // Espelha os dados reais da gen4 confirmados em OT-05H-U/W: BOLETO, R$5,
  // MONTHLY, nextDueDate original 2026-10-01.
  const TEMPORAL_INPUT: ProvisionSubscriptionInput = {
    establishmentId: TEMPORAL_EST,
    subscriptionGeneration: TEMPORAL_GEN,
    asaasCustomerId: "cus_temporal_1",
    leaseOwner: "worker_1",
    billingType: "BOLETO",
    value: 5,
    cycle: "MONTHLY",
    nextDueDate: "2026-10-01",
    description: "Livia sandbox controlled test",
  };

  function matchingTemporalSubscription(patch: Partial<AsaasSubscription> = {}): AsaasSubscription {
    return {
      id: TEMPORAL_SUB_ID,
      customer: TEMPORAL_INPUT.asaasCustomerId,
      billingType: TEMPORAL_INPUT.billingType,
      value: TEMPORAL_INPUT.value,
      cycle: TEMPORAL_INPUT.cycle,
      nextDueDate: TEMPORAL_INPUT.nextDueDate,
      externalReference: logicalSubscriptionExternalReference(TEMPORAL_EST, TEMPORAL_GEN),
      status: "ACTIVE",
      ...patch,
    };
  }

  function matchingTemporalPayment(patch: Partial<AsaasPayment> = {}): AsaasPayment {
    return {
      id: "pay_temporal_1",
      subscription: TEMPORAL_SUB_ID,
      customer: TEMPORAL_INPUT.asaasCustomerId,
      dueDate: TEMPORAL_INPUT.nextDueDate,
      value: TEMPORAL_INPUT.value,
      status: "PENDING",
      deleted: false,
      ...patch,
    };
  }

  type TemporalConflictClient = Pick<
    AsaasClient,
    "getSubscription" | "findSubscriptionsForReconciliation" | "listSubscriptionPayments"
  >;

  function temporalClient(
    subscriptionPatch: Partial<AsaasSubscription>,
    payments: AsaasPayment[],
    overrides: Partial<TemporalConflictClient> = {},
  ): TemporalConflictClient {
    return {
      getSubscription: vi.fn(),
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [matchingTemporalSubscription(subscriptionPatch)],
      })),
      listSubscriptionPayments: vi.fn(async () => ({ ok: true as const, data: payments })),
      ...overrides,
    };
  }

  function temporalDeps(client: TemporalConflictClient): ConflictRecoveryDependencies {
    let id = 0;
    return { asaas: client, now: () => 1_000, newId: () => `temporal_id_${++id}`, leaseDurationMs: 30_000 };
  }

  // Cria o estado de conflict via billingType inconsistente na resposta do
  // POST (mesmo mecanismo dos outros testes de recovery), preservando
  // TEMPORAL_SUB_ID como conflictSubscriptionIds[0].
  async function setupTemporalConflictState(): Promise<void> {
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => ({
        ok: true as const,
        data: matchingTemporalSubscription({ billingType: "PIX" }),
      })),
    });
    const result = await provisionAsaasSubscription(TEMPORAL_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict" });
    expect((await getBillingProvisioningIntent(TEMPORAL_EST, TEMPORAL_GEN))?.conflictSubscriptionIds).toEqual([
      TEMPORAL_SUB_ID,
    ]);
  }

  it("gen4 real: MONTHLY 2026-10-01 → 2026-11-01, payment PENDING/value 5/deleted:false ⇒ succeeded", async () => {
    await setupTemporalConflictState();
    const client = temporalClient(
      { nextDueDate: "2026-11-01" },
      [matchingTemporalPayment()],
    );
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "reconciled" });
    const stored = await getBillingProvisioningIntent(TEMPORAL_EST, TEMPORAL_GEN);
    expect(stored?.phase).toBe("succeeded");
    expect(stored?.externalSubscriptionId).toBe(TEMPORAL_SUB_ID);
    expect(client.listSubscriptionPayments).toHaveBeenCalledWith(TEMPORAL_SUB_ID);
  });

  it("avanço + payment deleted:true ⇒ conflict (original_payment_not_eligible)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, [matchingTemporalPayment({ deleted: true })]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  it("avanço + payment sem deleted (undefined) ⇒ fail-closed (original_payment_not_eligible)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, [matchingTemporalPayment({ deleted: undefined })]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  it("avanço + payment com value errado ⇒ conflict (original_payment_not_eligible)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, [matchingTemporalPayment({ value: 999 })]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  it("avanço + payment sem value ⇒ conflict (original_payment_not_eligible)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, [matchingTemporalPayment({ value: undefined })]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  it("avanço + payment com dueDate errado ⇒ conflict (original_payment_not_found)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, [matchingTemporalPayment({ dueDate: "2026-10-02" })]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_found" });
  });

  it("avanço + 0 candidatos ⇒ conflict (original_payment_not_found)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, []);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_found" });
  });

  it("avanço + 2 candidatos com o mesmo dueDate original ⇒ conflict (original_payment_ambiguous)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, [
      matchingTemporalPayment({ id: "pay_a" }),
      matchingTemporalPayment({ id: "pay_b" }),
    ]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_ambiguous" });
  });

  it("status desconhecido/não permitido ⇒ conflict (original_payment_not_eligible)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, [matchingTemporalPayment({ status: "RECEIVED" })]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  it("payment.customer presente e divergente ⇒ conflict (original_payment_not_eligible)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, [matchingTemporalPayment({ customer: "cus_outro" })]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  it("payment.subscription presente e divergente ⇒ conflict (original_payment_not_eligible)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01" }, [
      matchingTemporalPayment({ subscription: "sub_outra" }),
    ]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  it("retrocesso de nextDueDate ⇒ conflict (next_due_date_not_valid_cycle_advance), sem listar payments", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-09-01" }, []);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "next_due_date_not_valid_cycle_advance" });
    expect(client.listSubscriptionPayments).not.toHaveBeenCalled();
  });

  it("avanço que não corresponde a nenhum múltiplo do cycle ⇒ conflict (next_due_date_not_valid_cycle_advance)", async () => {
    await setupTemporalConflictState();
    // +15 dias não é múltiplo de nenhum ciclo mensal válido para MONTHLY.
    const client = temporalClient({ nextDueDate: "2026-10-16" }, []);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "next_due_date_not_valid_cycle_advance" });
    expect(client.listSubscriptionPayments).not.toHaveBeenCalled();
  });

  it("borda de mês ambígua (dia 31 → mês de 30 dias) falha fechado sem adivinhar convenção", async () => {
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => ({
        ok: true as const,
        data: matchingTemporalSubscription({
          nextDueDate: "2026-01-31",
          billingType: "PIX", // gera o conflict inicial
        }),
      })),
    });
    const ambiguousInput: ProvisionSubscriptionInput = { ...TEMPORAL_INPUT, nextDueDate: "2026-01-31" };
    const setupResult = await provisionAsaasSubscription(ambiguousInput, dependencies(client));
    expect(setupResult).toMatchObject({ ok: false, phase: "conflict" });

    // Nem clamp (2026-02-28) nem rollover (2026-03-03) devem ser aceitos:
    // a documentação da Asaas não define qual convenção seria usada.
    const clampClient = temporalClient({ nextDueDate: "2026-02-28" }, []);
    const clampResult = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(clampClient));
    expect(clampResult).toMatchObject({ ok: false, phase: "conflict", reason: "next_due_date_not_valid_cycle_advance" });

    fakeDb.reset();
    await provisionAsaasSubscription(ambiguousInput, dependencies(client));
    const rolloverClient = temporalClient({ nextDueDate: "2026-03-03" }, []);
    const rolloverResult = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(rolloverClient));
    expect(rolloverResult).toMatchObject({ ok: false, phase: "conflict", reason: "next_due_date_not_valid_cycle_advance" });
  });

  it("outro campo da subscription diverge além do nextDueDate avançado ⇒ conflict (subscription_mismatch)", async () => {
    await setupTemporalConflictState();
    const client = temporalClient({ nextDueDate: "2026-11-01", billingType: "PIX" }, [matchingTemporalPayment()]);
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "subscription_mismatch" });
    expect(client.listSubscriptionPayments).not.toHaveBeenCalled();
  });

  it("WEEKLY: avanço de exatamente 2 semanas (14 dias) com evidência ⇒ succeeded", async () => {
    const weeklyInput: ProvisionSubscriptionInput = { ...TEMPORAL_INPUT, cycle: "WEEKLY", nextDueDate: "2026-10-01" };
    const client = fakeAsaas({
      createSubscription: vi.fn(async () => ({
        ok: true as const,
        data: matchingTemporalSubscription({ cycle: "WEEKLY", billingType: "PIX" }),
      })),
    });
    await provisionAsaasSubscription(weeklyInput, dependencies(client));

    const recoveryClient = temporalClient(
      { cycle: "WEEKLY", nextDueDate: "2026-10-15" }, // +14 dias = 2 ciclos WEEKLY
      [matchingTemporalPayment({ dueDate: "2026-10-01" })],
    );
    const result = await reconcileConflictedSubscription(TEMPORAL_EST, TEMPORAL_GEN, "worker", temporalDeps(recoveryClient));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "reconciled" });
  });
});

describe("provisionAsaasSubscription — evidência pós-create de nextDueDate (OT-05H-AH)", () => {
  const CREATE_EST = "est_create_evidence";
  const CREATE_GEN = 1;
  const CREATE_SUB_ID = "sub_create_evidence_1";

  // Espelha o caso real da gen5 (RCA OT-05H-AG): BOLETO, R$5, MONTHLY,
  // nextDueDate 2026-12-01.
  const CREATE_INPUT: ProvisionSubscriptionInput = {
    establishmentId: CREATE_EST,
    subscriptionGeneration: CREATE_GEN,
    asaasCustomerId: "cus_create_1",
    leaseOwner: "worker_1",
    billingType: "BOLETO",
    value: 5,
    cycle: "MONTHLY",
    nextDueDate: "2026-12-01",
    description: "Livia sandbox controlled test",
  };

  function createdSubscription(patch: Partial<AsaasSubscription> = {}): AsaasSubscription {
    return {
      id: CREATE_SUB_ID,
      customer: CREATE_INPUT.asaasCustomerId,
      billingType: CREATE_INPUT.billingType,
      value: CREATE_INPUT.value,
      cycle: CREATE_INPUT.cycle,
      nextDueDate: CREATE_INPUT.nextDueDate,
      externalReference: logicalSubscriptionExternalReference(CREATE_EST, CREATE_GEN),
      description: CREATE_INPUT.description,
      status: "ACTIVE",
      ...patch,
    };
  }

  function createdPayment(patch: Partial<AsaasPayment> = {}): AsaasPayment {
    return {
      id: "pay_create_evidence_1",
      subscription: CREATE_SUB_ID,
      customer: CREATE_INPUT.asaasCustomerId,
      dueDate: CREATE_INPUT.nextDueDate,
      value: CREATE_INPUT.value,
      status: "PENDING",
      deleted: false,
      ...patch,
    };
  }

  function createClient(
    subscriptionPatch: Partial<AsaasSubscription>,
    payments: AsaasPayment[],
    overrides: Partial<ReconciliationClient> = {},
  ): ReconciliationClient {
    return fakeAsaas({
      createSubscription: vi.fn(async () => ({ ok: true as const, data: createdSubscription(subscriptionPatch) })),
      listSubscriptionPayments: vi.fn(async () => ({ ok: true as const, data: payments })),
      ...overrides,
    });
  }

  // 1
  it("nextDueDate igual: succeeded sem chamar listSubscriptionPayments", async () => {
    const client = createClient({}, []);
    const result = await provisionAsaasSubscription(CREATE_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "created" });
    expect(client.listSubscriptionPayments).not.toHaveBeenCalled();
  });

  // 2 — caso real da gen5
  it("gen5 real: nextDueDate diverge (2026-12-01 → 2027-01-01) + payment válido ⇒ succeeded", async () => {
    const client = createClient({ nextDueDate: "2027-01-01" }, [createdPayment()]);
    const result = await provisionAsaasSubscription(CREATE_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "created" });
    const stored = await getBillingProvisioningIntent(CREATE_EST, CREATE_GEN);
    expect(stored?.phase).toBe("succeeded");
    expect(stored?.externalSubscriptionId).toBe(CREATE_SUB_ID);
    expect(client.listSubscriptionPayments).toHaveBeenCalledWith(CREATE_SUB_ID);
  });

  // 3
  it("payment com dueDate diferente do original ⇒ conflict (evidência não encontrada)", async () => {
    const client = createClient({ nextDueDate: "2027-01-01" }, [createdPayment({ dueDate: "2026-12-02" })]);
    const result = await provisionAsaasSubscription(CREATE_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_found" });
  });

  // 4
  it("value divergente no payment ⇒ conflict", async () => {
    const client = createClient({ nextDueDate: "2027-01-01" }, [createdPayment({ value: 999 })]);
    const result = await provisionAsaasSubscription(CREATE_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  // 5
  it("payment deleted:true ⇒ conflict", async () => {
    const client = createClient({ nextDueDate: "2027-01-01" }, [createdPayment({ deleted: true })]);
    const result = await provisionAsaasSubscription(CREATE_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  // 6
  it("status diferente de PENDING ⇒ conflict", async () => {
    const client = createClient({ nextDueDate: "2027-01-01" }, [createdPayment({ status: "RECEIVED" })]);
    const result = await provisionAsaasSubscription(CREATE_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_not_eligible" });
  });

  // 7
  it("dois candidatos com o mesmo dueDate original ⇒ conflict, nunca adivinha", async () => {
    const client = createClient({ nextDueDate: "2027-01-01" }, [
      createdPayment({ id: "pay_a" }),
      createdPayment({ id: "pay_b" }),
    ]);
    const result = await provisionAsaasSubscription(CREATE_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "original_payment_ambiguous" });
  });

  // 8
  it("outro campo da subscription diverge além do nextDueDate ⇒ conflict, sem listar payments", async () => {
    const client = createClient({ nextDueDate: "2027-01-01", billingType: "PIX" }, [createdPayment()]);
    const result = await provisionAsaasSubscription(CREATE_INPUT, dependencies(client));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "created_subscription_mismatch" });
    expect(client.listSubscriptionPayments).not.toHaveBeenCalled();
  });

  // 9
  it("exatamente uma chamada createSubscription, mesmo com divergência de nextDueDate", async () => {
    const client = createClient({ nextDueDate: "2027-01-01" }, [createdPayment()]);
    await provisionAsaasSubscription(CREATE_INPUT, dependencies(client));
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
  });

  // 10a
  it("replay por ID conhecido continua usando subscriptionMatches estrito (regressão)", async () => {
    const firstClient = createClient({}, []);
    await provisionAsaasSubscription(CREATE_INPUT, dependencies(firstClient));
    const replayClient = fakeAsaas({
      getSubscription: vi.fn(async () => ({ ok: true as const, data: createdSubscription({ nextDueDate: "2027-01-01" }) })),
    });
    const replayResult = await provisionAsaasSubscription(CREATE_INPUT, dependencies(replayClient));
    expect(replayResult).toMatchObject({ ok: false, phase: "conflict", reason: "known_subscription_mismatch" });
    expect(replayClient.listSubscriptionPayments).not.toHaveBeenCalled();
  });

  // 10b
  it("reconciliação pré-create continua usando subscriptionMatches estrito (regressão)", async () => {
    const PRECREATE_GEN = 2;
    const precreateInput = { ...CREATE_INPUT, subscriptionGeneration: PRECREATE_GEN };
    const precreateClient = fakeAsaas({
      findSubscriptionsForReconciliation: vi.fn(async () => ({
        ok: true as const,
        data: [createdSubscription({
          nextDueDate: "2027-01-01",
          externalReference: logicalSubscriptionExternalReference(CREATE_EST, PRECREATE_GEN),
        })],
      })),
    });
    const precreateResult = await provisionAsaasSubscription(precreateInput, dependencies(precreateClient));
    expect(precreateResult).toMatchObject({ ok: false, phase: "conflict", reason: "subscription_mismatch" });
    expect(precreateClient.listSubscriptionPayments).not.toHaveBeenCalled();
  });
});
