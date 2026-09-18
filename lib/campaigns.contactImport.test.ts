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
  getCustomerProfile,
  importMarketingContacts,
  optOutCustomerFromMarketing,
  upsertCustomerProfile,
} from "@/lib/repo";

const A = "establishment-a";
const B = "establishment-b";
const PHONE = "5514996447132";
const declaration = { confirmedMarketingOptIn: true as const, source: "crm_import" as const };

beforeEach(() => {
  fakeDb.reset();
  sender.sendText.mockReset();
  sender.sendTemplate.mockReset();
});

describe("Campanhas-03 — importação de contatos e opt-in", () => {
  it("declaração válida torna contato importado eligible e registra a evidência", async () => {
    const result = await importMarketingContacts(A, {
      contacts: [{ phone: "(14) 99644-7132", name: "Nilton" }],
      declaration,
    });

    const profile = await getCustomerProfile(A, PHONE);
    expect(result).toMatchObject({ created: 1, eligible: 1, protected: 0 });
    expect(profile).toMatchObject({
      establishmentId: A,
      name: "Nilton",
      marketingStatus: "eligible",
      marketingOptInSource: "crm_import",
      marketingOptInDeclarationVersion: "whatsapp_marketing_consent_v1",
    });
    expect(profile?.marketingOptInAt).toEqual(expect.any(Number));
    expect(profile?.marketingOptInDeclarationAt).toEqual(expect.any(Number));
    expect(marketingEligibilityOf(profile!)).toEqual({ eligible: true, reason: "eligible" });
  });

  it("sem declaração explícita não importa nem torna contato elegível", async () => {
    await expect(importMarketingContacts(A, {
      contacts: [{ phone: PHONE }],
      declaration: { confirmedMarketingOptIn: false, source: "crm_import" } as never,
    })).rejects.toThrow("Declaração explícita");
    expect(await getCustomerProfile(A, PHONE)).toBeNull();
  });

  it("normaliza telefone e deduplica entradas do mesmo lote", async () => {
    const result = await importMarketingContacts(A, {
      contacts: [{ phone: "14996447132" }, { phone: "+55 14 99644-7132", name: "Nilton" }],
      declaration,
    });
    expect(result).toMatchObject({ received: 2, unique: 1, duplicates: 1, created: 1 });
    expect(fakeDb.col(`establishments/${A}/customers`).size).toBe(1);
    expect((await getCustomerProfile(A, PHONE))?.name).toBe("Nilton");
  });

  it("reimportação idêntica é idempotente e preserva a evidência original de opt-in", async () => {
    await importMarketingContacts(A, { contacts: [{ phone: PHONE, name: "Nilton" }], declaration });
    const first = await getCustomerProfile(A, PHONE);

    const retry = await importMarketingContacts(A, { contacts: [{ phone: PHONE, name: "Nilton" }], declaration });
    const second = await getCustomerProfile(A, PHONE);
    expect(retry).toMatchObject({ created: 0, alreadyEligible: 1, eligible: 0 });
    expect(fakeDb.col(`establishments/${A}/customers`).size).toBe(1);
    expect(second?.marketingOptInAt).toBe(first?.marketingOptInAt);
    expect(second?.marketingOptInDeclarationAt).toBe(first?.marketingOptInDeclarationAt);
  });

  it("rejeita telefone inválido antes de gravar qualquer perfil", async () => {
    await expect(importMarketingContacts(A, {
      contacts: [{ phone: "123" }], declaration,
    })).rejects.toThrow("Telefone de importação inválido");
    expect(fakeDb.col(`establishments/${A}/customers`).size).toBe(0);
  });

  it("enriquece CustomerProfile existente sem sobrescrever CRM confiável", async () => {
    await upsertCustomerProfile(A, PHONE, {
      name: "Nome CRM", preferredTime: "manhã", lastService: "Avaliação",
    });
    const result = await importMarketingContacts(A, {
      contacts: [{ phone: PHONE, name: "Nome Importado" }],
      declaration: { confirmedMarketingOptIn: true, source: "physical_store" },
    });
    expect(result).toMatchObject({ created: 0, eligible: 1 });
    expect(await getCustomerProfile(A, PHONE)).toMatchObject({
      name: "Nome CRM",
      preferredTime: "manhã",
      lastService: "Avaliação",
      marketingStatus: "eligible",
      marketingOptInSource: "physical_store",
    });
  });

  it("opted_out não é reativado por nova importação", async () => {
    await upsertCustomerProfile(A, PHONE, { name: "Nilton" });
    await optOutCustomerFromMarketing(A, PHONE, "pedido do cliente");
    const result = await importMarketingContacts(A, { contacts: [{ phone: PHONE }], declaration });
    expect(result.protected).toBe(1);
    expect(await getCustomerProfile(A, PHONE)).toMatchObject({
      marketingStatus: "opted_out",
      marketingOptOutReason: "pedido do cliente",
    });
  });

  it("blocked não é reativado por importação", async () => {
    await upsertCustomerProfile(A, PHONE, { name: "Nilton" });
    const profile = await getCustomerProfile(A, PHONE);
    fakeDb.col(`establishments/${A}/customers`).set(PHONE, { ...profile!, marketingStatus: "blocked" });

    const result = await importMarketingContacts(A, { contacts: [{ phone: PHONE }], declaration });
    expect(result.protected).toBe(1);
    expect((await getCustomerProfile(A, PHONE))?.marketingStatus).toBe("blocked");
  });

  it("isolamento: importação de A não cria nem altera CustomerProfile de B; legado continua fail-safe", async () => {
    await upsertCustomerProfile(B, PHONE, { name: "Cliente B" });
    await importMarketingContacts(A, { contacts: [{ phone: PHONE, name: "Cliente A" }], declaration });

    expect((await getCustomerProfile(A, PHONE))?.marketingStatus).toBe("eligible");
    const profileB = await getCustomerProfile(B, PHONE);
    expect(profileB?.name).toBe("Cliente B");
    expect(profileB?.marketingStatus).toBeUndefined();
    expect(marketingEligibilityOf(profileB!)).toEqual({
      eligible: false,
      reason: "legacy_without_explicit_consent",
    });
  });

  it("nenhuma operação de importação chama WhatsApp", async () => {
    await importMarketingContacts(A, { contacts: [{ phone: PHONE }], declaration });
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendTemplate).not.toHaveBeenCalled();
  });
});
