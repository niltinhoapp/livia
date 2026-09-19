import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/firebase/admin", async () => { const fake = await import("@/lib/__testing__/firestoreFake"); return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb }; });
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { createCampaign, getCampaign, prepareCampaignAudience, importMarketingContacts, previewCampaignAudience } from "@/lib/repo";

const A = "est-a"; const B = "est-b";
const template = { id: "tpl-1", name: "hello", languageCode: "pt_BR", status: "APPROVED", components: [{ type: "BODY", text: "Olá" }], senderCompatible: true };
beforeEach(() => fakeDb.reset());

async function eligible(establishmentId: string, phone: string, name: string) {
  await importMarketingContacts(establishmentId, { contacts: [{ phone, name }], declaration: { confirmedMarketingOptIn: true, source: "website_form" } });
}

describe("Campanhas-05 — audiência e recipients", () => {
  it("prévia usa contatos do próprio tenant, deduplica telefone e não materializa recipients", async () => {
    await eligible(A, "5514996447132", "A");
    await eligible(B, "5514996447132", "B");
    fakeDb.col(`establishments/${A}/customers`).set("dup", { phone: "(14) 99644-7132", marketingStatus: "eligible" });
    const preview = await previewCampaignAudience(A);
    expect(preview).toEqual({ selected: 1, eligible: 1, excluded: 0 });
    expect(fakeDb.col(`establishments/${A}/campaignRecipients`).size).toBe(0);
  });

  it("materializa todos os elegíveis, exclui protegidos/legados e normaliza", async () => {
    await eligible(A, "(14) 99644-7132", "Ana");
    fakeDb.col(`establishments/${A}/customers`).set("5514996447000", { phone: "5514996447000", name: "Optout", marketingStatus: "opted_out" });
    fakeDb.col(`establishments/${A}/customers`).set("5514996447001", { phone: "5514996447001", name: "Blocked", marketingStatus: "blocked" });
    fakeDb.col(`establishments/${A}/customers`).set("5514996447002", { phone: "5514996447002", name: "Legacy" });
    const campaign = await createCampaign(A, { name: "Teste" });
    const result = await prepareCampaignAudience(A, campaign.id, { selection: "all_eligible", template });
    expect(result).toMatchObject({ selected: 4, eligible: 1, excluded: 3, recipientsCreated: 1 });
    expect(fakeDb.col(`establishments/${A}/campaignRecipients`).size).toBe(1);
    expect((await getCampaign(A, campaign.id))?.counters).toMatchObject({ total: 1, queued: 1, sent: 0 });
  });

  it("seleção explícita é idempotente e isolada por tenant", async () => {
    await eligible(A, "5514996447132", "A"); await eligible(B, "5514996447132", "B");
    const campaign = await createCampaign(A, { name: "Seleção" });
    const input = { selection: "selected" as const, phones: ["(14) 99644-7132", "5514996447132"], template };
    const first = await prepareCampaignAudience(A, campaign.id, input); const second = await prepareCampaignAudience(A, campaign.id, input);
    expect(first.recipientsCreated).toBe(1); expect(second.recipientsCreated).toBe(0);
    expect(fakeDb.col(`establishments/${A}/campaignRecipients`).size).toBe(1);
    expect(fakeDb.col(`establishments/${B}/campaignRecipients`).size).toBe(0);
  });

  it("bloqueia template não aprovado ou incompatível e volume síncrono excessivo", async () => {
    await eligible(A, "5514996447132", "A"); const campaign = await createCampaign(A, { name: "Bloqueada" });
    await expect(prepareCampaignAudience(A, campaign.id, { selection: "all_eligible", template: { ...template, status: "PENDING" } })).rejects.toThrow();
    await expect(prepareCampaignAudience(A, campaign.id, { selection: "all_eligible", template: { ...template, senderCompatible: false } })).rejects.toThrow();
  });
});
