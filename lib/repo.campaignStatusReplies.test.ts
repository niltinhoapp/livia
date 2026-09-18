// Status Meta (sent/delivered/read/failed) + correlação de resposta do
// cliente (CAMPANHAS-07). Camada de dados só — o webhook em si é testado em
// app/api/webhooks/whatsapp/route.statusObservability.test.ts e
// route.campaignReplies.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
vi.mock("@/lib/whatsapp/client", () => ({
  normalizePhone: (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    return digits.length <= 11 ? `55${digits}` : digits;
  },
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { applyCampaignDeliveryStatus, correlateCampaignReply } from "@/lib/repo";
import type { Campaign, CampaignRecipient } from "@/types";

const A = "establishment-a";
const B = "establishment-b";
const CAMPAIGN_ID = "campaign-1";

function seedCampaign(establishmentId: string, campaignId = CAMPAIGN_ID, overrides: Partial<Campaign> = {}): void {
  const campaign: Campaign = {
    id: campaignId,
    establishmentId,
    name: "Campanha de teste",
    status: "running",
    scheduledAt: null,
    startedAt: Date.now(),
    finishedAt: null,
    counters: { total: 1, queued: 0, sent: 1, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 },
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
    customerPhone: "5511999000001",
    status: "sent",
    attempts: 1,
    createdAt: Date.now(),
    sentAt: Date.now(),
    metaMessageId: `wamid.${id}`,
    ...overrides,
  };
  fakeDb.col(`establishments/${establishmentId}/campaignRecipients`).set(id, recipient as unknown as Record<string, unknown>);
}

function getRecipient(establishmentId: string, id: string): CampaignRecipient {
  return fakeDb.col(`establishments/${establishmentId}/campaignRecipients`).get(id) as unknown as CampaignRecipient;
}

function getCampaignDoc(establishmentId: string, campaignId = CAMPAIGN_ID): Campaign {
  return fakeDb.col(`establishments/${establishmentId}/campaigns`).get(campaignId) as unknown as Campaign;
}

beforeEach(() => {
  fakeDb.reset();
  seedCampaign(A);
});

describe("Campanhas-07 — status Meta (sent/delivered/read/failed)", () => {
  it("1) delivered atualiza recipient e counters", async () => {
    seedRecipient(A, "r1");
    const result = await applyCampaignDeliveryStatus(A, "wamid.r1", "delivered");
    expect(result).toBe("applied");
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("delivered");
    expect(recipient.deliveredAt).toBeDefined();
    expect(getCampaignDoc(A).counters.delivered).toBe(1);
  });

  it("2) read (sem delivered prévio) credita delivered E read de uma vez, pois ler implica ter sido entregue", async () => {
    seedRecipient(A, "r1");
    const result = await applyCampaignDeliveryStatus(A, "wamid.r1", "read");
    expect(result).toBe("applied");
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("read");
    expect(recipient.deliveredAt).toBeDefined();
    expect(recipient.readAt).toBeDefined();
    const campaign = getCampaignDoc(A);
    expect(campaign.counters.delivered).toBe(1);
    expect(campaign.counters.read).toBe(1);
  });

  it("read depois de delivered já registrado só credita read (não duplica delivered)", async () => {
    seedRecipient(A, "r1");
    await applyCampaignDeliveryStatus(A, "wamid.r1", "delivered");
    await applyCampaignDeliveryStatus(A, "wamid.r1", "read");
    expect(getCampaignDoc(A).counters).toMatchObject({ delivered: 1, read: 1 });
  });

  it("3) failed pós-envio marca recipient e soma counters.failed sem tocar counters.sent", async () => {
    seedRecipient(A, "r1");
    const result = await applyCampaignDeliveryStatus(A, "wamid.r1", "failed", { code: 131047, title: "Re-engagement message" });
    expect(result).toBe("applied");
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("failed");
    expect(recipient.failureReason).toContain("code=131047");
    expect(recipient.failureReason).toContain("Re-engagement message");
    const campaign = getCampaignDoc(A);
    expect(campaign.counters.failed).toBe(1);
    expect(campaign.counters.sent).toBe(1); // não regride: o envio de fato aconteceu
  });

  it("4) evento duplicado (delivered repetido) não duplica counters", async () => {
    seedRecipient(A, "r1");
    await applyCampaignDeliveryStatus(A, "wamid.r1", "delivered");
    const second = await applyCampaignDeliveryStatus(A, "wamid.r1", "delivered");
    expect(second).toBe("no_change");
    expect(getCampaignDoc(A).counters.delivered).toBe(1);
  });

  it("5) sent atrasado (chega depois de read) não regride status nem duplica counters", async () => {
    seedRecipient(A, "r1");
    await applyCampaignDeliveryStatus(A, "wamid.r1", "read");
    const late = await applyCampaignDeliveryStatus(A, "wamid.r1", "sent");
    expect(late).toBe("no_change");
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("read");
    expect(getCampaignDoc(A).counters).toMatchObject({ delivered: 1, read: 1 });
  });

  it("6) delivered atrasado (chega depois de read) não regride status", async () => {
    seedRecipient(A, "r1");
    await applyCampaignDeliveryStatus(A, "wamid.r1", "read");
    const late = await applyCampaignDeliveryStatus(A, "wamid.r1", "delivered");
    expect(late).toBe("no_change");
    expect(getRecipient(A, "r1").status).toBe("read");
    expect(getCampaignDoc(A).counters.delivered).toBe(1); // já creditado pelo "read", não duplicado
  });

  it("7) recipient é localizado corretamente por wamid (não por id do documento)", async () => {
    seedRecipient(A, "recipient-com-outro-id", { metaMessageId: "wamid.especifico" });
    const result = await applyCampaignDeliveryStatus(A, "wamid.especifico", "delivered");
    expect(result).toBe("applied");
    expect(getRecipient(A, "recipient-com-outro-id").status).toBe("delivered");
  });

  it("8) wamid desconhecido não quebra — retorna not_found", async () => {
    seedRecipient(A, "r1");
    await expect(applyCampaignDeliveryStatus(A, "wamid.nao-existe", "delivered")).resolves.toBe("not_found");
  });

  it("9) tenant isolation: status aplicado em A nunca toca recipient de B", async () => {
    seedCampaign(B);
    seedRecipient(A, "r1", { metaMessageId: "wamid.compartilhado" });
    seedRecipient(B, "r1", { metaMessageId: "wamid.compartilhado" });

    await applyCampaignDeliveryStatus(A, "wamid.compartilhado", "delivered");

    expect(getRecipient(A, "r1").status).toBe("delivered");
    expect(getRecipient(B, "r1").status).toBe("sent"); // intocado
    expect(getCampaignDoc(B).counters.delivered).toBe(0);
  });

  it("status não regride um recipient já 'replied'", async () => {
    seedRecipient(A, "r1", { status: "replied", repliedAt: Date.now() });
    const result = await applyCampaignDeliveryStatus(A, "wamid.r1", "read");
    expect(result).toBe("no_change");
    expect(getRecipient(A, "r1").status).toBe("replied");
  });
});

describe("Campanhas-07 — correlação de resposta do cliente", () => {
  it("10) primeira resposta marca replied e incrementa counter", async () => {
    seedRecipient(A, "r1");
    const result = await correlateCampaignReply(A, "5511999000001");
    expect(result).toBe("applied");
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("replied");
    expect(recipient.repliedAt).toBeDefined();
    expect(getCampaignDoc(A).counters.replied).toBe(1);
  });

  it("11) segunda resposta do mesmo cliente não incrementa de novo", async () => {
    seedRecipient(A, "r1");
    await correlateCampaignReply(A, "5511999000001");
    const second = await correlateCampaignReply(A, "5511999000001");
    expect(second).toBe("already_replied");
    expect(getCampaignDoc(A).counters.replied).toBe(1);
  });

  it("12) campanha fora da janela de 7 dias não recebe reply", async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    seedRecipient(A, "r1", { sentAt: eightDaysAgo });
    const result = await correlateCampaignReply(A, "5511999000001");
    expect(result).toBe("no_match");
    expect(getRecipient(A, "r1").status).toBe("sent");
  });

  it("13) duas campanhas possíveis: vence a de sentAt mais recente (regra determinística)", async () => {
    seedCampaign(A, "campaign-old");
    seedCampaign(A, "campaign-new");
    seedRecipient(A, "r-old", { campaignId: "campaign-old", sentAt: Date.now() - 5 * 24 * 60 * 60 * 1000, metaMessageId: "wamid.old" });
    seedRecipient(A, "r-new", { campaignId: "campaign-new", sentAt: Date.now() - 1 * 24 * 60 * 60 * 1000, metaMessageId: "wamid.new" });

    const result = await correlateCampaignReply(A, "5511999000001");

    expect(result).toBe("applied");
    expect(getRecipient(A, "r-new").status).toBe("replied");
    expect(getRecipient(A, "r-old").status).toBe("sent"); // não tocado
    expect(getCampaignDoc(A, "campaign-new").counters.replied).toBe(1);
    expect(getCampaignDoc(A, "campaign-old").counters.replied).toBe(0);
  });

  it("telefone sem nenhum CampaignRecipient é no-op seguro", async () => {
    const result = await correlateCampaignReply(A, "5511900000000");
    expect(result).toBe("no_match");
  });

  it("isolamento: reply em A nunca marca recipient de B com o mesmo telefone", async () => {
    seedCampaign(B);
    seedRecipient(A, "r1");
    seedRecipient(B, "r1");

    await correlateCampaignReply(A, "5511999000001");

    expect(getRecipient(A, "r1").status).toBe("replied");
    expect(getRecipient(B, "r1").status).toBe("sent");
    expect(getCampaignDoc(B).counters.replied).toBe(0);
  });

  it("recipient com status failed/skipped nunca é elegível para reply", async () => {
    seedRecipient(A, "r1", { status: "failed", failedAt: Date.now() });
    const result = await correlateCampaignReply(A, "5511999000001");
    expect(result).toBe("no_match");
  });
});
