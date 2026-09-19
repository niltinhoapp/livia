import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { activateCampaign, completeCampaignIfDrained, getCampaign, startDueScheduledCampaign } from "@/lib/repo";
import type { Campaign, CampaignRecipient } from "@/types";

const ESTABLISHMENT_ID = "est-a";
const CAMPAIGN_ID = "c1";

function seedCampaign(overrides: Partial<Campaign> = {}) {
  const campaign: Campaign = {
    id: CAMPAIGN_ID,
    establishmentId: ESTABLISHMENT_ID,
    name: "Teste",
    status: "draft",
    template: { id: "t1", name: "approved", languageCode: "pt_BR", status: "APPROVED", senderCompatible: true },
    audience: { selectedCount: 2, eligibleRecipientCount: 2, excludedCount: 0, selection: "all_eligible", selectedAt: 1 },
    scheduledAt: null,
    startedAt: null,
    finishedAt: null,
    counters: { total: 2, queued: 2, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
  fakeDb.col(`establishments/${ESTABLISHMENT_ID}/campaigns`).set(CAMPAIGN_ID, campaign as unknown as Record<string, unknown>);
}

function seedRecipient(id: string, status: CampaignRecipient["status"] = "pending") {
  fakeDb.col(`establishments/${ESTABLISHMENT_ID}/campaignRecipients`).set(id, {
    id, establishmentId: ESTABLISHMENT_ID, campaignId: CAMPAIGN_ID, customerPhone: `5511999000${id}`, status, createdAt: 1,
  });
}

describe("ativação controlada de campanhas", () => {
  beforeEach(() => {
    fakeDb.reset();
    seedCampaign();
    seedRecipient("1");
    seedRecipient("2");
  });

  it("ativa agora uma campanha preparada", async () => {
    const result = await activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "now", maxRecipients: 5, now: 100 });
    expect(result.kind).toBe("activated");
    expect((result as { campaign: Campaign }).campaign.status).toBe("running");
  });

  it("não ativa draft sem audiência/template/recipients ou acima do limite", async () => {
    seedCampaign({ audience: undefined });
    expect(await activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "now", maxRecipients: 5 })).toMatchObject({ kind: "invalid", reason: "audience_required" });
    seedCampaign({ audience: { selectedCount: 2, eligibleRecipientCount: 2, excludedCount: 0, selection: "all_eligible", selectedAt: 1 }, template: undefined });
    expect(await activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "now", maxRecipients: 5 })).toMatchObject({ kind: "invalid", reason: "approved_compatible_template_required" });
    seedCampaign({ audience: { selectedCount: 2, eligibleRecipientCount: 2, excludedCount: 0, selection: "all_eligible", selectedAt: 1 } });
    expect(await activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "now", maxRecipients: 1 })).toMatchObject({ kind: "invalid", reason: "recipient_limit_exceeded" });
  });

  it("é idempotente e não reativa campanha já liberada", async () => {
    await activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "now", maxRecipients: 5, now: 100 });
    const second = await activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "now", maxRecipients: 5, now: 200 });
    expect(second).toMatchObject({ kind: "already_activated", campaign: { status: "running", activatedAt: 100 } });
  });

  it("duas ativações concorrentes liberam a campanha uma única vez", async () => {
    const [first, second] = await Promise.all([
      activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "now", maxRecipients: 5, now: 100 }),
      activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "now", maxRecipients: 5, now: 200 }),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["activated", "already_activated"]);
    await expect(getCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID)).resolves.toMatchObject({ status: "running" });
  });

  it("agendamento futuro só vira running quando vence", async () => {
    const scheduled = await activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "scheduled", scheduledAt: 500, maxRecipients: 5, now: 100 });
    expect(scheduled).toMatchObject({ kind: "activated", campaign: { status: "scheduled" } });
    expect((await startDueScheduledCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, 400))?.status).toBe("scheduled");
    expect((await startDueScheduledCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, 500))?.status).toBe("running");
  });

  it("só conclui depois que não há pending/queued/leased", async () => {
    await activateCampaign(ESTABLISHMENT_ID, CAMPAIGN_ID, { mode: "now", maxRecipients: 5, now: 100 });
    expect(await completeCampaignIfDrained(ESTABLISHMENT_ID, CAMPAIGN_ID, 200)).toBe(false);
    fakeDb.col(`establishments/${ESTABLISHMENT_ID}/campaignRecipients`).set("1", { status: "sent" });
    fakeDb.col(`establishments/${ESTABLISHMENT_ID}/campaignRecipients`).set("2", { status: "skipped" });
    expect(await completeCampaignIfDrained(ESTABLISHMENT_ID, CAMPAIGN_ID, 300)).toBe(true);
  });
});
