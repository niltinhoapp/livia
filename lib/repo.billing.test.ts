import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EstablishmentBilling } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { db: fake.fakeDb, establishmentRef: fake.establishmentRef, sub: fake.sub };
});

const { linkEstablishmentBilling } = await import("./repo");
const { fakeDb } = await import("@/lib/__testing__/firestoreFake");

beforeEach(() => {
  fakeDb.reset();
});

function seedBilling(id: string, billing: EstablishmentBilling) {
  fakeDb.col("establishments").set(id, { id, name: "N", billing } as unknown as Record<string, unknown>);
}
function readBilling(id: string): EstablishmentBilling | undefined {
  return (fakeDb.col("establishments").get(id) as { billing?: EstablishmentBilling } | undefined)?.billing;
}

// OT-07E0: writer do vínculo Asaas. Só cobre o delta desta OT.
describe("linkEstablishmentBilling", () => {
  it("persiste externalCustomerId preservando billingStatus/trial existentes", async () => {
    seedBilling("est_1", { billingStatus: "trial", trialStartAt: 100, trialEndsAt: 700, updatedAt: 100 });
    await linkEstablishmentBilling("est_1", { externalCustomerId: "cus_1" });

    const b = readBilling("est_1")!;
    expect(b.externalCustomerId).toBe("cus_1");
    expect(b.billingStatus).toBe("trial");
    expect(b.trialStartAt).toBe(100);
    expect(b.trialEndsAt).toBe(700);
    expect(b.updatedAt).toBeGreaterThanOrEqual(100);
  });

  it("persiste externalSubscriptionId no mesmo contrato quando informado", async () => {
    seedBilling("est_2", { billingStatus: "trial", trialStartAt: 1, trialEndsAt: 2, updatedAt: 1 });
    await linkEstablishmentBilling("est_2", { externalCustomerId: "cus_2", externalSubscriptionId: "sub_2" });

    const b = readBilling("est_2")!;
    expect(b.externalCustomerId).toBe("cus_2");
    expect(b.externalSubscriptionId).toBe("sub_2");
    expect(b.billingStatus).toBe("trial");
  });

  it("establishment legado sem billing: cria o mapa só com o vínculo, sem inventar trial, sem crash", async () => {
    fakeDb.col("establishments").set("est_legacy", { id: "est_legacy", name: "L" } as unknown as Record<string, unknown>);
    await linkEstablishmentBilling("est_legacy", { externalCustomerId: "cus_legacy" });

    const b = readBilling("est_legacy")!;
    expect(b.externalCustomerId).toBe("cus_legacy");
    expect(b.billingStatus).toBeUndefined();
    expect(b.trialStartAt).toBeUndefined();
  });

  it("repetição não produz vínculo inconsistente (converge para o mesmo externalCustomerId)", async () => {
    seedBilling("est_3", { billingStatus: "active", updatedAt: 1 });
    await linkEstablishmentBilling("est_3", { externalCustomerId: "cus_3" });
    await linkEstablishmentBilling("est_3", { externalCustomerId: "cus_3" });

    const b = readBilling("est_3")!;
    expect(b.externalCustomerId).toBe("cus_3");
    expect(b.billingStatus).toBe("active");
  });
});
