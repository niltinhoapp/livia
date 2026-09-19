import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import type { AsaasCheckout, AsaasClient, AsaasError, CreateCheckoutInput } from "./asaas";
import {
  checkoutFingerprint,
  getBillingCheckoutIntent,
  logicalCheckoutExternalReference,
  provisionBillingCheckout,
  resolveCheckoutCorrelation,
  type CheckoutProvisioningDependencies,
  type ProvisionCheckoutInput,
} from "./checkoutProvisioning";

const INPUT: ProvisionCheckoutInput = {
  establishmentId: "est_1",
  subscriptionGeneration: 1,
  leaseOwner: "worker_1",
  value: 129,
  cycle: "MONTHLY",
  nextDueDate: "2026-10-19",
  successUrl: "https://livia-seven.vercel.app/painel/plano?checkout=success",
  cancelUrl: "https://livia-seven.vercel.app/painel/plano?checkout=cancel",
  expiredUrl: "https://livia-seven.vercel.app/painel/plano?checkout=expired",
};

let checkoutCounter = 0;
function fakeCheckout(patch: Partial<AsaasCheckout> = {}): AsaasCheckout {
  checkoutCounter += 1;
  return {
    id: `chk_${checkoutCounter}`,
    link: `https://sandbox.asaas.com/checkoutSession/show/chk_${checkoutCounter}`,
    status: "ACTIVE",
    externalReference: logicalCheckoutExternalReference(INPUT.establishmentId, INPUT.subscriptionGeneration),
    ...patch,
  };
}

type CheckoutClient = Pick<AsaasClient, "createCheckout">;

function fakeAsaas(overrides: Partial<CheckoutClient> = {}): CheckoutClient {
  return {
    createCheckout: vi.fn(async (_input: CreateCheckoutInput) => ({ ok: true as const, data: fakeCheckout() })),
    ...overrides,
  };
}

function dependencies(asaas: CheckoutClient, now = 1_000_000): CheckoutProvisioningDependencies {
  let counter = 0;
  return { asaas, now: () => now, newId: () => `id_${(counter += 1)}` };
}

function httpError(status: number): AsaasError {
  return { kind: "http", status, message: `HTTP ${status}` };
}

beforeEach(() => {
  fakeDb.reset();
  checkoutCounter = 0;
});

describe("provisionBillingCheckout — criação", () => {
  it("cria um Checkout novo, persiste o intent em phase 'created' e devolve id/link", async () => {
    const client = fakeAsaas();
    const result = await provisionBillingCheckout(INPUT, dependencies(client));
    expect(result.ok && result.outcome).toBe("created");
    expect(result.ok && result.intent.checkoutId).toMatch(/^chk_/);
    expect(result.ok && result.intent.checkoutLink).toContain("sandbox.asaas.com");
    expect(client.createCheckout).toHaveBeenCalledTimes(1);
    expect(client.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        billingTypes: ["CREDIT_CARD"],
        chargeTypes: ["RECURRENT"],
        externalReference: logicalCheckoutExternalReference(INPUT.establishmentId, INPUT.subscriptionGeneration),
        subscription: { cycle: "MONTHLY", nextDueDate: "2026-10-19" },
      }),
    );
  });

  it("persiste o vínculo checkoutId -> (establishmentId, generation) em _asaas_checkout_correlations ANTES de qualquer redirecionamento poder acontecer", async () => {
    const client = fakeAsaas();
    const result = await provisionBillingCheckout(INPUT, dependencies(client));
    const checkoutId = result.ok && "checkoutId" in result.intent ? result.intent.checkoutId! : null;
    expect(checkoutId).toBeTruthy();
    const correlation = await resolveCheckoutCorrelation(checkoutId!);
    expect(correlation).toEqual({
      establishmentId: INPUT.establishmentId,
      subscriptionGeneration: INPUT.subscriptionGeneration,
      createdAt: 1_000_000,
    });
  });

  it("um establishment nunca contamina o vínculo de outro: gerações/establishments distintos produzem correlações distintas", async () => {
    const client = fakeAsaas();
    const r1 = await provisionBillingCheckout(INPUT, dependencies(client));
    const r2 = await provisionBillingCheckout({ ...INPUT, establishmentId: "est_2" }, dependencies(client));
    const id1 = r1.ok && "checkoutId" in r1.intent ? r1.intent.checkoutId! : null;
    const id2 = r2.ok && "checkoutId" in r2.intent ? r2.intent.checkoutId! : null;
    expect(id1).not.toBe(id2);
    const c1 = await resolveCheckoutCorrelation(id1!);
    const c2 = await resolveCheckoutCorrelation(id2!);
    expect(c1?.establishmentId).toBe("est_1");
    expect(c2?.establishmentId).toBe("est_2");
  });
});

describe("provisionBillingCheckout — idempotência (double-click/refresh/retry)", () => {
  it("chamada repetida da MESMA tentativa (mesmo establishment/generation/terms), com o Checkout ainda válido, devolve o MESMO checkoutId sem criar outro", async () => {
    const client = fakeAsaas();
    const deps = dependencies(client);
    const first = await provisionBillingCheckout(INPUT, deps);
    const second = await provisionBillingCheckout(INPUT, deps);

    expect(client.createCheckout).toHaveBeenCalledTimes(1); // só 1 POST real
    expect(second.ok && second.outcome).toBe("reused");
    expect(first.ok && second.ok && "checkoutId" in first.intent && "checkoutId" in second.intent && first.intent.checkoutId).toBe(
      second.ok && "checkoutId" in second.intent ? second.intent.checkoutId : undefined,
    );
  });

  it("retry da callback Firestore (transaction) não duplica o Checkout", async () => {
    fakeDb.retryNextTransaction(1);
    const client = fakeAsaas();
    const result = await provisionBillingCheckout(INPUT, dependencies(client));
    expect(result.ok && result.outcome).toBe("created");
    expect(client.createCheckout).toHaveBeenCalledTimes(1);
  });
});

describe("provisionBillingCheckout — concorrência", () => {
  it("duas chamadas concorrentes para a MESMA tentativa: só uma cria o Checkout de verdade, a outra fica 'busy'", async () => {
    let releaseCreate!: () => void;
    let createStarted!: () => void;
    const started = new Promise<void>((resolve) => (createStarted = resolve));
    const blocked = new Promise<void>((resolve) => (releaseCreate = resolve));
    const client = fakeAsaas({
      createCheckout: vi.fn(async () => {
        createStarted();
        await blocked;
        return { ok: true as const, data: fakeCheckout() };
      }),
    });
    const deps = dependencies(client);

    const first = provisionBillingCheckout(INPUT, deps);
    await started;
    const second = await provisionBillingCheckout({ ...INPUT, leaseOwner: "worker_2" }, deps);
    expect(second.ok && second.outcome).toBe("busy");
    releaseCreate();
    const winner = await first;
    expect(winner.ok && winner.outcome).toBe("created");
    expect(client.createCheckout).toHaveBeenCalledTimes(1);
  });

  it("estabelecimentos DIFERENTES nunca competem pela mesma lease — ambos criam Checkouts concorrentemente sem conflito", async () => {
    const client = fakeAsaas();
    const deps = dependencies(client);
    const [r1, r2] = await Promise.all([
      provisionBillingCheckout(INPUT, deps),
      provisionBillingCheckout({ ...INPUT, establishmentId: "est_other" }, deps),
    ]);
    expect(r1.ok && r1.outcome).toBe("created");
    expect(r2.ok && r2.outcome).toBe("created");
    expect(client.createCheckout).toHaveBeenCalledTimes(2);
  });
});

describe("provisionBillingCheckout — expiração", () => {
  it("Checkout expirado: uma nova tentativa cria um Checkout NOVO (nunca reaproveita o link morto)", async () => {
    const client = fakeAsaas();
    let now = 1_000_000;
    const deps: CheckoutProvisioningDependencies = { asaas: client, now: () => now, newId: (() => {
      let n = 0;
      return () => `id_${(n += 1)}`;
    })() };

    const first = await provisionBillingCheckout({ ...INPUT, minutesToExpire: 10 }, deps);
    const firstId = first.ok && "checkoutId" in first.intent ? first.intent.checkoutId : null;

    now += 11 * 60_000; // passou da validade (10 min)
    const second = await provisionBillingCheckout({ ...INPUT, minutesToExpire: 10 }, deps);
    const secondId = second.ok && "checkoutId" in second.intent ? second.intent.checkoutId : null;

    expect(client.createCheckout).toHaveBeenCalledTimes(2);
    expect(secondId).not.toBe(firstId);
    expect(second.ok && second.outcome).toBe("created");
  });

  it("Checkout expirado gera uma correlação NOVA para o novo checkoutId — a correlação antiga do id expirado permanece (órfã, inofensiva)", async () => {
    const client = fakeAsaas();
    let now = 1_000_000;
    const deps: CheckoutProvisioningDependencies = { asaas: client, now: () => now, newId: (() => {
      let n = 0;
      return () => `id_${(n += 1)}`;
    })() };
    const first = await provisionBillingCheckout({ ...INPUT, minutesToExpire: 10 }, deps);
    const firstId = first.ok && "checkoutId" in first.intent ? first.intent.checkoutId! : "";

    now += 11 * 60_000;
    const second = await provisionBillingCheckout({ ...INPUT, minutesToExpire: 10 }, deps);
    const secondId = second.ok && "checkoutId" in second.intent ? second.intent.checkoutId! : "";

    const oldCorrelation = await resolveCheckoutCorrelation(firstId);
    const newCorrelation = await resolveCheckoutCorrelation(secondId);
    expect(oldCorrelation?.establishmentId).toBe(INPUT.establishmentId); // ainda existe, mas nunca mais referenciada pelo intent
    expect(newCorrelation?.establishmentId).toBe(INPUT.establishmentId);
  });
});

describe("provisionBillingCheckout — falhas", () => {
  it("rejeição conclusiva (HTTP 400) marca failed_terminal, sem reter lease", async () => {
    const client = fakeAsaas({ createCheckout: vi.fn(async () => ({ ok: false as const, error: httpError(400) })) });
    const result = await provisionBillingCheckout(INPUT, dependencies(client));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("asaas_rejected");
  });

  it("falha transitória (timeout/rede) libera a lease e permite retry pleno (novo POST) — Checkout perdido nunca é uma assinatura", async () => {
    let attempt = 0;
    const client = fakeAsaas({
      createCheckout: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) return { ok: false as const, error: { kind: "network", message: "timeout" } as AsaasError };
        return { ok: true as const, data: fakeCheckout() };
      }),
    });
    const deps = dependencies(client);
    const first = await provisionBillingCheckout(INPUT, deps);
    expect(first.ok).toBe(true); // outcome "busy"/reserved — nunca falha dura por transitório
    const second = await provisionBillingCheckout(INPUT, deps);
    expect(second.ok && second.outcome).toBe("created");
    expect(client.createCheckout).toHaveBeenCalledTimes(2);
  });
});

describe("checkoutFingerprint / logicalCheckoutExternalReference", () => {
  it("fingerprint muda quando o valor muda, mantém quando os termos são idênticos", () => {
    const a = checkoutFingerprint({ value: 129, cycle: "MONTHLY", nextDueDate: "2026-10-19" });
    const b = checkoutFingerprint({ value: 129, cycle: "MONTHLY", nextDueDate: "2026-10-19" });
    const c = checkoutFingerprint({ value: 199, cycle: "MONTHLY", nextDueDate: "2026-10-19" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("externalReference do checkout nunca é confundido com o de subscription (namespace distinto)", () => {
    expect(logicalCheckoutExternalReference("est_1", 1)).toBe("livia:checkout:est_1:1");
  });
});

describe("getBillingCheckoutIntent", () => {
  it("devolve null quando não existe nenhuma tentativa para essa geração", async () => {
    expect(await getBillingCheckoutIntent("est_never", 1)).toBeNull();
  });

  it("devolve o intent persistido após uma criação bem-sucedida", async () => {
    const client = fakeAsaas();
    await provisionBillingCheckout(INPUT, dependencies(client));
    const intent = await getBillingCheckoutIntent(INPUT.establishmentId, INPUT.subscriptionGeneration);
    expect(intent?.phase).toBe("created");
    expect(intent?.checkoutId).toBeTruthy();
  });
});
