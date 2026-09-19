// Fase 1 do gating de billing: applyBillingStatusExpiry (trial_expired /
// grace_expired). Transição + suspendedAt, idempotente por construção via
// nextBillingStatus (lib/billing/stateMachine.ts, não alterada aqui).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { applyBillingStatusExpiry } from "@/lib/repo";
import type { Establishment } from "@/types";

const EST_ID = "est-1";

function seedEstablishment(overrides: Partial<Establishment> = {}): void {
  const est: Establishment = {
    id: EST_ID,
    name: "Estabelecimento",
    type: "outro",
    ownerUid: EST_ID,
    status: "active",
    createdAt: 1,
    bot: { personaName: "Livia", tone: "", bookingEnabled: false, handoffKeywords: [], medicalGuardrail: false },
    ...overrides,
  };
  fakeDb.col("establishments").set(EST_ID, est as unknown as Record<string, unknown>);
}

function getEstablishment(): Establishment {
  return fakeDb.col("establishments").get(EST_ID) as unknown as Establishment;
}

beforeEach(() => {
  fakeDb.reset();
});

describe("Fase 1 billing — applyBillingStatusExpiry", () => {
  it("trial_expired: trial -> suspended, grava suspendedAt", async () => {
    seedEstablishment({ billing: { billingStatus: "trial", trialStartAt: 1, trialEndsAt: 100, updatedAt: 1 } });

    const result = await applyBillingStatusExpiry(EST_ID, "trial_expired", 5000);

    expect(result).toBe("applied");
    const est = getEstablishment();
    expect(est.billing?.billingStatus).toBe("suspended");
    expect(est.billing?.suspendedAt).toBe(5000);
    expect(est.billing?.updatedAt).toBe(5000);
  });

  it("grace_expired: past_due -> suspended, grava suspendedAt", async () => {
    seedEstablishment({ billing: { billingStatus: "past_due", lastAsaasEventAt: 1000, updatedAt: 1000 } });

    const result = await applyBillingStatusExpiry(EST_ID, "grace_expired", 9000);

    expect(result).toBe("applied");
    expect(getEstablishment().billing?.billingStatus).toBe("suspended");
    expect(getEstablishment().billing?.suspendedAt).toBe(9000);
  });

  it("idempotente: rodar trial_expired duas vezes não regride nem reescreve suspendedAt", async () => {
    seedEstablishment({ billing: { billingStatus: "trial", trialStartAt: 1, trialEndsAt: 100, updatedAt: 1 } });

    await applyBillingStatusExpiry(EST_ID, "trial_expired", 5000);
    const second = await applyBillingStatusExpiry(EST_ID, "trial_expired", 9000);

    expect(second).toBe("no_change"); // já suspended: trial_expired não é transição válida a partir daqui
    expect(getEstablishment().billing?.suspendedAt).toBe(5000); // não reescreveu
  });

  it("não regride: establishment já active não é afetado por grace_expired", async () => {
    seedEstablishment({ billing: { billingStatus: "active", updatedAt: 1 } });

    const result = await applyBillingStatusExpiry(EST_ID, "grace_expired", 9000);

    expect(result).toBe("no_change");
    expect(getEstablishment().billing?.billingStatus).toBe("active");
    expect(getEstablishment().billing?.suspendedAt).toBeUndefined();
  });

  it("regularização no meio do caminho vence: se o webhook já reativou antes do cron rodar, o cron não sobrescreve", async () => {
    // Simula a corrida: establishment estava past_due, o webhook Asaas já
    // confirmou pagamento (active) ANTES de o cron chegar a chamar isto.
    seedEstablishment({ billing: { billingStatus: "active", lastAsaasEventAt: 1000, updatedAt: 2000 } });

    const result = await applyBillingStatusExpiry(EST_ID, "grace_expired", 9000);

    expect(result).toBe("no_change");
    expect(getEstablishment().billing?.billingStatus).toBe("active");
  });

  it("establishment sem billing (legado) é no-op seguro", async () => {
    seedEstablishment({});
    const result = await applyBillingStatusExpiry(EST_ID, "trial_expired", 9000);
    expect(result).toBe("no_change");
  });

  it("establishment inexistente é no-op seguro (nunca lança)", async () => {
    await expect(applyBillingStatusExpiry("nao-existe", "trial_expired", 9000)).resolves.toBe("no_change");
  });
});
