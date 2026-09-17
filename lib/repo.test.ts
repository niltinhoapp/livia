import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { db: fake.fakeDb, establishmentRef: fake.establishmentRef, sub: fake.sub };
});

const { upsertEstablishmentConfig, initialTrialBilling } = await import("./repo");
const { fakeDb } = await import("@/lib/__testing__/firestoreFake");

beforeEach(() => {
  fakeDb.reset();
});

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// OT-07C: delta de inicialização automática do trial em upsertEstablishmentConfig.
// Demais comportamentos de upsert (name/type/bot merge) já eram exercitados
// indiretamente via app/api/establishment antes desta OT e não são repetidos aqui.
describe("upsertEstablishmentConfig — billing inicial (OT-07C)", () => {
  it("novo establishment recebe trial de 7 dias", async () => {
    const est = await upsertEstablishmentConfig("est_new", { name: "Novo" });
    expect(est.billing?.billingStatus).toBe("trial");
    expect(est.billing?.trialStartAt).toBeTypeOf("number");
    expect(est.billing?.trialEndsAt! - est.billing?.trialStartAt!).toBe(SEVEN_DAYS_MS);
    expect(est.billing?.updatedAt).toBe(est.billing?.trialStartAt);
  });

  it("update de establishment existente não reinicia trial", async () => {
    const created = await upsertEstablishmentConfig("est_existing", { name: "Original" });
    const originalBilling = created.billing;

    const updated = await upsertEstablishmentConfig("est_existing", { name: "Renomeado" });

    expect(updated.billing).toEqual(originalBilling);
    expect(updated.name).toBe("Renomeado");
  });

  it("billing existente (ex.: pós-pagamento) é preservado em update", async () => {
    await upsertEstablishmentConfig("est_paid", { name: "Pago" });
    // Simula billing já avançado por um webhook real (fora do escopo desta OT).
    await fakeDb.collection("establishments").doc("est_paid").set(
      { billing: { billingStatus: "active", updatedAt: 999 } },
      { merge: true },
    );

    const updated = await upsertEstablishmentConfig("est_paid", { name: "Pago renomeado" });

    expect(updated.billing).toEqual({ billingStatus: "active", updatedAt: 999 });
  });
});

// initialTrialBilling é reutilizado também por lib/panelAccess.ts
// (caminho alternativo de criação) — coberto em lib/panelAccess.test.ts.
describe("initialTrialBilling (OT-07C)", () => {
  it("deriva trialStartAt e trialEndsAt do mesmo instante", () => {
    const now = 1_700_000_000_000;
    expect(initialTrialBilling(now)).toEqual({
      billingStatus: "trial",
      trialStartAt: now,
      trialEndsAt: now + SEVEN_DAYS_MS,
      updatedAt: now,
    });
  });
});
