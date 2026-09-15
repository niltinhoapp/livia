import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import type { AsaasClient, AsaasCustomer, AsaasError } from "./asaas";
import {
  getSandboxCustomerIntent,
  provisionSandboxCustomer,
  sandboxCustomerFingerprint,
  type ProvisionSandboxCustomerInput,
  type SandboxCustomerDependencies,
} from "./asaasSandboxCustomer";

const INPUT: ProvisionSandboxCustomerInput = {
  testRunId: "run-0001",
  externalReference: "livia:sandbox-test:run-0001:customer",
  name: "Livia Sandbox Test run-0001",
  cpfCnpj: "12345678901",
};

const CUSTOMER: AsaasCustomer = {
  id: "cus_test_1",
  name: INPUT.name,
  externalReference: INPUT.externalReference,
};

type CustomerClient = Pick<AsaasClient, "findCustomersByExternalReference" | "createCustomer">;

function failure(kind: AsaasError["kind"], status?: number) {
  return {
    ok: false as const,
    error: { kind, ...(status !== undefined ? { status } : {}), message: "sanitized" } satisfies AsaasError,
  };
}

function client(overrides: Partial<CustomerClient> = {}): CustomerClient {
  return {
    findCustomersByExternalReference: vi.fn(async () => ({ ok: true as const, data: [] })),
    createCustomer: vi.fn(async () => ({ ok: true as const, data: CUSTOMER })),
    ...overrides,
  };
}

function dependencies(
  asaas: CustomerClient,
  options: Partial<Omit<SandboxCustomerDependencies, "asaas">> = {},
): SandboxCustomerDependencies {
  let id = 0;
  return {
    asaas,
    now: () => 1_000,
    newId: () => `attempt_${++id}`,
    ...options,
  };
}

beforeEach(() => {
  fakeDb.reset();
});

describe("identidade durável", () => {
  it("mesma intenção gera fingerprint estável sem persistir documento bruto", () => {
    expect(sandboxCustomerFingerprint(INPUT)).toBe(sandboxCustomerFingerprint({ ...INPUT }));
    expect(sandboxCustomerFingerprint({ ...INPUT, cpfCnpj: "12345678901234" }))
      .not.toBe(sandboxCustomerFingerprint(INPUT));
  });

  it("identidade/fingerprint incompatível falha fechado antes de novo lookup ou POST", async () => {
    const first = client();
    await provisionSandboxCustomer(INPUT, dependencies(first));

    const replay = client();
    const result = await provisionSandboxCustomer(
      { ...INPUT, cpfCnpj: "12345678901234" },
      dependencies(replay),
    );

    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "identity_conflict" });
    expect(replay.findCustomersByExternalReference).not.toHaveBeenCalled();
    expect(replay.createCustomer).not.toHaveBeenCalled();
    expect(JSON.stringify(await getSandboxCustomerIntent(INPUT.testRunId))).not.toContain(INPUT.cpfCnpj);
  });
});

describe("ambiguidade e replay", () => {
  it("POST timeout + reconciliação vazia persiste phase=reconciling", async () => {
    const asaas = client({
      findCustomersByExternalReference: vi.fn(async () => ({ ok: true as const, data: [] })),
      createCustomer: vi.fn(async () => failure("timeout")),
    });

    const result = await provisionSandboxCustomer(INPUT, dependencies(asaas));
    const stored = await getSandboxCustomerIntent(INPUT.testRunId);

    expect(result).toMatchObject({ ok: true, phase: "reconciling", outcome: "awaiting_reconciliation" });
    expect(stored).toMatchObject({
      phase: "reconciling",
      attemptId: "attempt_1",
      externalCustomerId: null,
      lastAttemptAt: 1_000,
      lastError: { kind: "timeout" },
    });
    expect(asaas.createCustomer).toHaveBeenCalledTimes(1);
    expect(asaas.findCustomersByExternalReference).toHaveBeenCalledTimes(2);
  });

  it("request posterior ainda vazia faz somente lookup e zero novo POST", async () => {
    const first = client({ createCustomer: vi.fn(async () => failure("network")) });
    await provisionSandboxCustomer(INPUT, dependencies(first));

    const replay = client();
    const result = await provisionSandboxCustomer(INPUT, dependencies(replay));

    expect(result).toMatchObject({ ok: true, phase: "reconciling", outcome: "awaiting_reconciliation" });
    expect(replay.findCustomersByExternalReference).toHaveBeenCalledTimes(1);
    expect(replay.createCustomer).not.toHaveBeenCalled();
  });

  it("processo novo após ambiguidade continua impedido de repetir POST", async () => {
    await provisionSandboxCustomer(
      INPUT,
      dependencies(client({ createCustomer: vi.fn(async () => failure("timeout")) })),
    );

    // Novos client/dependencies simulam restart; somente Firestore sobrevive.
    const afterRestart = client();
    const result = await provisionSandboxCustomer(INPUT, dependencies(afterRestart));
    expect(result.phase).toBe("reconciling");
    expect(afterRestart.createCustomer).not.toHaveBeenCalled();
  });

  it("customer que aparece depois é reconciliado e externalCustomerId é persistido", async () => {
    await provisionSandboxCustomer(
      INPUT,
      dependencies(client({ createCustomer: vi.fn(async () => failure("timeout")) })),
    );
    const replay = client({
      findCustomersByExternalReference: vi.fn(async () => ({ ok: true as const, data: [CUSTOMER] })),
    });

    const result = await provisionSandboxCustomer(INPUT, dependencies(replay));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "reconciled" });
    expect(await getSandboxCustomerIntent(INPUT.testRunId)).toMatchObject({
      phase: "succeeded",
      externalCustomerId: CUSTOMER.id,
    });
    expect(replay.createCustomer).not.toHaveBeenCalled();
  });

  it("replay de sucesso verifica por lookup e executa zero POST", async () => {
    const initial = client();
    await provisionSandboxCustomer(INPUT, dependencies(initial));

    const replay = client({
      findCustomersByExternalReference: vi.fn(async () => ({ ok: true as const, data: [CUSTOMER] })),
    });
    const result = await provisionSandboxCustomer(INPUT, dependencies(replay));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "verified" });
    expect(replay.createCustomer).not.toHaveBeenCalled();
  });

  it.each(["timeout", "network"] as const)(
    "succeeded + falha transitória %s preserva sucesso e externalCustomerId",
    async (kind) => {
      await provisionSandboxCustomer(INPUT, dependencies(client()));
      const before = await getSandboxCustomerIntent(INPUT.testRunId);
      const replay = client({
        findCustomersByExternalReference: vi.fn(async () => failure(kind)),
      });

      const result = await provisionSandboxCustomer(INPUT, dependencies(replay));
      const after = await getSandboxCustomerIntent(INPUT.testRunId);

      expect(result).toMatchObject({
        ok: true,
        phase: "succeeded",
        outcome: "verification_failed",
        verificationError: { kind },
      });
      expect(after).toEqual(before);
      expect(after).toMatchObject({ phase: "succeeded", externalCustomerId: CUSTOMER.id });
      expect(replay.createCustomer).not.toHaveBeenCalled();
    },
  );

  it("succeeded + customer diferente vira conflict sem POST", async () => {
    await provisionSandboxCustomer(INPUT, dependencies(client()));
    const replay = client({
      findCustomersByExternalReference: vi.fn(async () => ({
        ok: true as const,
        data: [{ ...CUSTOMER, id: "cus_other" }],
      })),
    });

    const result = await provisionSandboxCustomer(INPUT, dependencies(replay));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "customer_id_changed" });
    expect(await getSandboxCustomerIntent(INPUT.testRunId)).toMatchObject({ phase: "conflict" });
    expect(replay.createCustomer).not.toHaveBeenCalled();
  });

  it("succeeded + lookup vazio mantém fail-closed e executa zero POST", async () => {
    await provisionSandboxCustomer(INPUT, dependencies(client()));
    const replay = client();

    const result = await provisionSandboxCustomer(INPUT, dependencies(replay));
    expect(result).toMatchObject({ ok: false, phase: "conflict", reason: "known_customer_missing" });
    expect(await getSandboxCustomerIntent(INPUT.testRunId)).toMatchObject({ phase: "conflict" });
    expect(replay.createCustomer).not.toHaveBeenCalled();
  });
});

describe("concorrência e transactions", () => {
  it("duas requests concorrentes para o mesmo run executam no máximo um POST", async () => {
    let lookupCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const asaas = client({
      findCustomersByExternalReference: vi.fn(async () => {
        lookupCount += 1;
        if (lookupCount === 2) release();
        await gate;
        return { ok: true as const, data: [] };
      }),
      createCustomer: vi.fn(async () => {
        return { ok: true as const, data: CUSTOMER };
      }),
    });
    let attemptSequence = 0;
    const sharedClockAndIds = {
      now: () => 1_000,
      newId: () => `attempt_${++attemptSequence}`,
    };

    const [a, b] = await Promise.all([
      provisionSandboxCustomer(INPUT, dependencies(asaas, sharedClockAndIds)),
      provisionSandboxCustomer(INPUT, dependencies(asaas, sharedClockAndIds)),
    ]);

    expect(asaas.createCustomer).toHaveBeenCalledTimes(1);
    expect([a.phase, b.phase]).toContain("succeeded");
    expect((await getSandboxCustomerIntent(INPUT.testRunId))?.externalCustomerId).toBe(CUSTOMER.id);
  });

  it("retry da transaction que concede criação não duplica POST nem executa Asaas dentro da transaction", async () => {
    const asaas = client({
      findCustomersByExternalReference: vi.fn(async () => {
        expect(fakeDb.isTransactionActive()).toBe(false);
        // A próxima transaction é beginCreation; o fake descarta a primeira
        // callback e repete, como o Firestore em conflito otimista.
        fakeDb.retryNextTransaction(1);
        return { ok: true as const, data: [] };
      }),
      createCustomer: vi.fn(async () => {
        expect(fakeDb.isTransactionActive()).toBe(false);
        return { ok: true as const, data: CUSTOMER };
      }),
    });

    const result = await provisionSandboxCustomer(INPUT, dependencies(asaas));
    expect(result).toMatchObject({ ok: true, phase: "succeeded", outcome: "created" });
    expect(asaas.createCustomer).toHaveBeenCalledTimes(1);
  });
});
