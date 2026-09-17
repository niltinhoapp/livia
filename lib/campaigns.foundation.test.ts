import { beforeEach, describe, expect, it, vi } from "vitest";

const sender = vi.hoisted(() => ({ sendText: vi.fn(), sendTemplate: vi.fn() }));

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

vi.mock("@/lib/whatsapp/client", () => ({
  normalizePhone: (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    return digits.length <= 11 ? `55${digits}` : digits;
  },
  ...sender,
}));

import { marketingEligibilityOf } from "@/lib/campaigns";
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  createCampaign,
  getCampaign,
  getCustomerProfile,
  loadConversation,
  optOutCustomerFromMarketing,
  upsertCustomerProfile,
} from "@/lib/repo";

const A = "establishment-a";
const B = "establishment-b";
const PHONE = "5514996447132";

beforeEach(() => {
  fakeDb.reset();
  sender.sendText.mockReset();
  sender.sendTemplate.mockReset();
});

describe("Campanhas-02 — fundação tenant-scoped e opt-out", () => {
  it("cria Campaign draft no tenant, sem recipient nem envio WhatsApp", async () => {
    const campaign = await createCampaign(A, { name: "  Retorno de setembro  " });

    expect(campaign).toMatchObject({
      establishmentId: A,
      name: "Retorno de setembro",
      status: "draft",
      scheduledAt: null,
      startedAt: null,
      finishedAt: null,
      counters: { total: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 },
    });
    expect(await getCampaign(A, campaign.id)).toEqual(campaign);
    expect(fakeDb.col(`establishments/${A}/campaignRecipients`).size).toBe(0);
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendTemplate).not.toHaveBeenCalled();
  });

  it("isolamento: establishment B não lê Campaign criada por A", async () => {
    const campaign = await createCampaign(A, { name: "Campanha A" });
    expect(await getCampaign(B, campaign.id)).toBeNull();
    expect(await getCampaign(A, campaign.id)).not.toBeNull();
  });

  it("perfil legado sem marketingStatus é inelegível por segurança", () => {
    expect(marketingEligibilityOf({})).toEqual({
      eligible: false,
      reason: "legacy_without_explicit_consent",
    });
  });

  it("somente status eligible libera marketing; opted_out e blocked prevalecem", () => {
    expect(marketingEligibilityOf({ marketingStatus: "eligible" })).toEqual({ eligible: true, reason: "eligible" });
    expect(marketingEligibilityOf({ marketingStatus: "opted_out" })).toEqual({ eligible: false, reason: "opted_out" });
    expect(marketingEligibilityOf({ marketingStatus: "blocked" })).toEqual({ eligible: false, reason: "blocked" });
  });

  it("opt-out é idempotente, preserva o CRM e não bloqueia a conversa", async () => {
    await upsertCustomerProfile(A, PHONE, { name: "Nilton", lastService: "Avaliação" });
    const { conversation } = await loadConversation(A, PHONE, "Nilton");

    expect(await optOutCustomerFromMarketing(A, PHONE, "pedido do cliente")).toBe("opted_out");
    const once = await getCustomerProfile(A, PHONE);
    expect(once).toMatchObject({
      name: "Nilton",
      lastService: "Avaliação",
      marketingStatus: "opted_out",
      marketingOptOutReason: "pedido do cliente",
    });
    expect(marketingEligibilityOf(once!)).toEqual({ eligible: false, reason: "opted_out" });

    expect(await optOutCustomerFromMarketing(A, PHONE, "tentativa posterior")).toBe("already_opted_out");
    const twice = await getCustomerProfile(A, PHONE);
    expect(twice?.marketingOptOutAt).toBe(once?.marketingOptOutAt);
    expect(twice?.marketingOptOutReason).toBe("pedido do cliente");

    await upsertCustomerProfile(A, PHONE, { lastIntent: "general_question" });
    expect((await getCustomerProfile(A, PHONE))?.lastIntent).toBe("general_question");
    expect((await loadConversation(A, PHONE, "Nilton")).conversation.status).toBe(conversation.status);
  });

  it("isolamento: opt-out de A não altera CustomerProfile de B", async () => {
    await Promise.all([
      upsertCustomerProfile(A, PHONE, { name: "Cliente A" }),
      upsertCustomerProfile(B, PHONE, { name: "Cliente B" }),
    ]);

    expect(await optOutCustomerFromMarketing(A, PHONE)).toBe("opted_out");
    expect((await getCustomerProfile(A, PHONE))?.marketingStatus).toBe("opted_out");
    const profileB = await getCustomerProfile(B, PHONE);
    expect(profileB?.name).toBe("Cliente B");
    expect(profileB?.marketingStatus).toBeUndefined();
    expect(marketingEligibilityOf(profileB!)).toEqual({
      eligible: false,
      reason: "legacy_without_explicit_consent",
    });
  });

  it("não cria perfil fantasma ao receber opt-out de contato inexistente", async () => {
    expect(await optOutCustomerFromMarketing(A, PHONE)).toBe("customer_not_found");
    expect(await getCustomerProfile(A, PHONE)).toBeNull();
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendTemplate).not.toHaveBeenCalled();
  });
});
