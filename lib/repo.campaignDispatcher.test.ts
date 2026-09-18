// Camada de dados do dispatcher (CAMPANHAS-06): claim/lease transacional e
// finalização idempotente dos counters. Elegibilidade/envio à Meta são
// testados em lib/campaignDispatcher.test.ts — aqui só Firestore.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { applyCampaignRecipientOutcome, claimCampaignRecipients, recordCampaignRecipientAttemptStart } from "@/lib/repo";
import type { Campaign, CampaignRecipient } from "@/types";

const A = "establishment-a";
const B = "establishment-b";
const CAMPAIGN_ID = "campaign-1";

function seedCampaign(establishmentId: string, campaignId: string, overrides: Partial<Campaign> = {}): void {
  const campaign: Campaign = {
    id: campaignId,
    establishmentId,
    name: "Campanha de teste",
    status: "running",
    scheduledAt: null,
    startedAt: Date.now(),
    finishedAt: null,
    counters: { total: 10, queued: 10, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
  fakeDb.col(`establishments/${establishmentId}/campaigns`).set(campaignId, campaign as unknown as Record<string, unknown>);
}

function seedRecipient(establishmentId: string, id: string, overrides: Partial<CampaignRecipient> = {}): void {
  const recipient: CampaignRecipient = {
    id,
    establishmentId,
    campaignId: CAMPAIGN_ID,
    customerPhone: `5511999${id.padStart(6, "0")}`,
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
    ...overrides,
  };
  fakeDb.col(`establishments/${establishmentId}/campaignRecipients`).set(id, recipient as unknown as Record<string, unknown>);
}

function getRecipient(establishmentId: string, id: string): CampaignRecipient {
  return fakeDb.col(`establishments/${establishmentId}/campaignRecipients`).get(id) as unknown as CampaignRecipient;
}

function getCampaignDoc(establishmentId: string, campaignId: string): Campaign {
  return fakeDb.col(`establishments/${establishmentId}/campaigns`).get(campaignId) as unknown as Campaign;
}

beforeEach(() => {
  fakeDb.reset();
  seedCampaign(A, CAMPAIGN_ID);
});

describe("Campanhas-06 — claim/lease", () => {
  it("worker que começou antes de completed não reivindica recipient depois da conclusão", async () => {
    seedRecipient(A, "r1");
    fakeDb.col(`establishments/${A}/campaigns`).set(CAMPAIGN_ID, {
      ...getCampaignDoc(A, CAMPAIGN_ID),
      status: "completed",
      finishedAt: 2_000,
    } as unknown as Record<string, unknown>);

    const claimed = await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 2_001 });

    expect(claimed).toHaveLength(0);
    expect(getRecipient(A, "r1").status).toBe("pending");
  });

  it("dois workers disputando o mesmo recipient: só um vence", async () => {
    seedRecipient(A, "r1");

    const [claimA, claimB] = await Promise.all([
      claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000 }),
      claimCampaignRecipients(A, CAMPAIGN_ID, "worker-b", { now: 1_000 }),
    ]);

    const totalClaimed = claimA.length + claimB.length;
    expect(totalClaimed).toBe(1);
    const winner = claimA.length === 1 ? "worker-a" : "worker-b";
    expect(getRecipient(A, "r1").leaseOwner).toBe(winner);
  });

  it("lease expirado sem tentativa de envio é recuperável por outro worker", async () => {
    seedRecipient(A, "r1");
    const first = await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000, leaseTtlMs: 1_000 });
    expect(first).toHaveLength(1);

    // Antes de expirar: lease válido não pode ser roubado.
    const tooEarly = await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-b", { now: 1_500 });
    expect(tooEarly).toHaveLength(0);

    // Depois de expirar, sem leaseAttemptStarted: reclamável.
    const recovered = await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-b", { now: 5_000 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0].leaseOwner).toBe("worker-b");
    expect(getRecipient(A, "r1").status).toBe("leased");
  });

  it("lease válido não pode ser roubado por outro worker", async () => {
    seedRecipient(A, "r1");
    await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000, leaseTtlMs: 60_000 });

    const stolen = await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-b", { now: 2_000 });
    expect(stolen).toHaveLength(0);
    expect(getRecipient(A, "r1").leaseOwner).toBe("worker-a");
  });

  it("lease expirado APÓS tentativa de envio nunca é reclamado — finaliza ambíguo", async () => {
    seedRecipient(A, "r1");
    const claimed = await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000, leaseTtlMs: 1_000 });
    expect(claimed).toHaveLength(1);
    // Persistido ANTES da chamada de rede — simula que a Meta pode ter aceitado.
    await recordCampaignRecipientAttemptStart(A, "r1", "worker-a", 1_100);

    const recovered = await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-b", { now: 5_000 });
    expect(recovered).toHaveLength(0); // NUNCA reclamado automaticamente

    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("failed");
    expect(recipient.ambiguous).toBe(true);
    expect(recipient.failureReason).toBe("lease_expired_after_send_attempt");

    const campaign = getCampaignDoc(A, CAMPAIGN_ID);
    expect(campaign.counters.failed).toBe(1);
    expect(campaign.counters.queued).toBe(9);
  });

  it("isolamento: claim em A nunca reivindica recipient de B", async () => {
    seedCampaign(B, CAMPAIGN_ID);
    seedRecipient(A, "r1");
    seedRecipient(B, "r1");

    const claimedA = await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000 });
    expect(claimedA).toHaveLength(1);
    expect(getRecipient(B, "r1").status).toBe("pending");
    expect(getRecipient(B, "r1").leaseOwner).toBeUndefined();
  });

  it("campanha grande é processada em lotes — claim nunca excede batchSize", async () => {
    for (let i = 0; i < 45; i++) seedRecipient(A, `r${i}`);

    const firstBatch = await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000, batchSize: 20 });
    expect(firstBatch).toHaveLength(20);

    const stillPending = [...fakeDb.col(`establishments/${A}/campaignRecipients`).values()].filter(
      (r) => (r as unknown as CampaignRecipient).status === "pending",
    );
    expect(stillPending).toHaveLength(25);

    // Nenhum contador de campanha avança só por ter sido reivindicado.
    expect(getCampaignDoc(A, CAMPAIGN_ID).counters.queued).toBe(10);
  });
});

describe("Campanhas-06 — finalização idempotente dos counters", () => {
  it("sent persiste metaMessageId e avança counters exatamente uma vez", async () => {
    seedRecipient(A, "r1");
    await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000 });

    const applied = await applyCampaignRecipientOutcome(A, CAMPAIGN_ID, "r1", "worker-a", { kind: "sent", metaMessageId: "wamid.123" });
    expect(applied).toBe("applied");

    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("sent");
    expect(recipient.metaMessageId).toBe("wamid.123");

    const campaign = getCampaignDoc(A, CAMPAIGN_ID);
    expect(campaign.counters.sent).toBe(1);
    expect(campaign.counters.queued).toBe(9);
  });

  it("uma segunda finalização do mesmo recipient (lease já perdido) é no-op — não duplica counters", async () => {
    seedRecipient(A, "r1");
    await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000 });
    await applyCampaignRecipientOutcome(A, CAMPAIGN_ID, "r1", "worker-a", { kind: "sent", metaMessageId: "wamid.123" });

    // worker-a tenta finalizar de novo (ex.: reprocessamento acidental).
    const second = await applyCampaignRecipientOutcome(A, CAMPAIGN_ID, "r1", "worker-a", { kind: "sent", metaMessageId: "wamid.999" });
    expect(second).toBe("stale_lease");

    const campaign = getCampaignDoc(A, CAMPAIGN_ID);
    expect(campaign.counters.sent).toBe(1); // não duplicou
    expect(getRecipient(A, "r1").metaMessageId).toBe("wamid.123"); // não sobrescreveu
  });

  it("worker diferente do dono do lease não consegue finalizar", async () => {
    seedRecipient(A, "r1");
    await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000 });

    const result = await applyCampaignRecipientOutcome(A, CAMPAIGN_ID, "r1", "worker-intruso", { kind: "sent" });
    expect(result).toBe("stale_lease");
    expect(getRecipient(A, "r1").status).toBe("leased");
    expect(getRecipient(A, "r1").leaseOwner).toBe("worker-a");
  });

  it("retry não é terminal: counters não avançam, recipient volta a ficar reivindicável", async () => {
    seedRecipient(A, "r1");
    await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000 });

    await applyCampaignRecipientOutcome(A, CAMPAIGN_ID, "r1", "worker-a", {
      kind: "retry",
      reason: "meta_error status=500 code=1",
      nextAttemptAt: 10_000,
    });

    const campaign = getCampaignDoc(A, CAMPAIGN_ID);
    expect(campaign.counters.queued).toBe(10); // intocado, ainda não é terminal
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("queued");
    expect(recipient.nextAttemptAt).toBe(10_000);

    // Antes do nextAttemptAt: não reivindicável.
    expect(await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-b", { now: 5_000 })).toHaveLength(0);
    // Depois: reivindicável de novo.
    expect(await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-b", { now: 10_000 })).toHaveLength(1);
  });

  it("skipped avança counters sem nunca ter passado por leaseAttemptStarted", async () => {
    seedRecipient(A, "r1");
    await claimCampaignRecipients(A, CAMPAIGN_ID, "worker-a", { now: 1_000 });

    await applyCampaignRecipientOutcome(A, CAMPAIGN_ID, "r1", "worker-a", { kind: "skipped", reason: "opted_out" });

    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("skipped");
    expect(recipient.failureReason).toBe("opted_out");
    expect(getCampaignDoc(A, CAMPAIGN_ID).counters.skipped).toBe(1);
  });
});
