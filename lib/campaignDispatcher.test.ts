// Orquestração do dispatcher (CAMPANHAS-06): revalidação de elegibilidade,
// classificação de erro e chamada ao sender — mockado, NUNCA a Meta real.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sender = vi.hoisted(() => ({ sendTemplate: vi.fn(), sendText: vi.fn() }));

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

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { classifySendError, dispatchCampaignBatch } from "@/lib/campaignDispatcher";
import { upsertCustomerProfile } from "@/lib/repo";
import type { Campaign, CampaignRecipient, Establishment } from "@/types";

const A = "establishment-a";
const CAMPAIGN_ID = "campaign-1";
const CONNECTED_WA = { status: "connected", phoneNumberId: "phone-a", accessToken: { ciphertext: "x", iv: "y", authTag: "z" } };

function seedEstablishment(id: string, overrides: Partial<Establishment> = {}): void {
  fakeDb.col("establishments").set(id, {
    id,
    name: "Estabelecimento teste",
    type: "salao",
    whatsapp: CONNECTED_WA,
    ...overrides,
  } as unknown as Record<string, unknown>);
}

function seedCampaign(establishmentId: string, overrides: Partial<Campaign> = {}): void {
  const campaign: Campaign = {
    id: CAMPAIGN_ID,
    establishmentId,
    name: "Campanha de teste",
    status: "running",
    template: { name: "reativacao", languageCode: "pt_BR", status: "APPROVED", senderCompatible: true },
    scheduledAt: null,
    startedAt: Date.now(),
    finishedAt: null,
    counters: { total: 1, queued: 1, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
  fakeDb.col(`establishments/${establishmentId}/campaigns`).set(CAMPAIGN_ID, campaign as unknown as Record<string, unknown>);
}

function seedRecipient(establishmentId: string, id: string, phone: string, overrides: Partial<CampaignRecipient> = {}): void {
  const recipient: CampaignRecipient = {
    id,
    establishmentId,
    campaignId: CAMPAIGN_ID,
    customerPhone: phone,
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

function getCampaignDoc(establishmentId: string): Campaign {
  return fakeDb.col(`establishments/${establishmentId}/campaigns`).get(CAMPAIGN_ID) as unknown as Campaign;
}

beforeEach(() => {
  fakeDb.reset();
  sender.sendTemplate.mockReset();
  sender.sendText.mockReset();
  seedEstablishment(A);
  seedCampaign(A);
});

describe("Campanhas-06 — revalidação de elegibilidade no envio", () => {
  it("opt-out registrado DEPOIS do snapshot da audiência impede o envio", async () => {
    await upsertCustomerProfile(A, "5511999000001", { name: "Cliente" });
    // opt-out acontece só agora — depois do recipient já existir como pending.
    fakeDb.col(`establishments/${A}/customers`).set("5511999000001", {
      phone: "5511999000001",
      establishmentId: A,
      marketingStatus: "opted_out",
      lastInteractionAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    seedRecipient(A, "r1", "5511999000001");

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("skipped");
    expect(recipient.failureReason).toBe("opted_out");
  });

  it("blocked impede o envio", async () => {
    fakeDb.col(`establishments/${A}/customers`).set("5511999000002", {
      phone: "5511999000002",
      establishmentId: A,
      marketingStatus: "blocked",
      lastInteractionAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    seedRecipient(A, "r1", "5511999000002");

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(getRecipient(A, "r1").failureReason).toBe("blocked");
  });

  it("perfil inexistente no momento do envio (fail-safe) é skipped, nunca enviado", async () => {
    seedRecipient(A, "r1", "5511999000003"); // nunca virou CustomerProfile

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(getRecipient(A, "r1").failureReason).toBe("customer_not_found_at_send_time");
  });

  it("recipient elegível chega ao sender e sucesso persiste o wamid", async () => {
    fakeDb.col(`establishments/${A}/customers`).set("5511999000004", {
      phone: "5511999000004",
      establishmentId: A,
      marketingStatus: "eligible",
      lastInteractionAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    seedRecipient(A, "r1", "5511999000004");
    sender.sendTemplate.mockResolvedValueOnce({ waMessageId: "wamid.abc" });

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(sender.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sender.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "connected" }),
      A,
      "5511999000004",
      "reativacao",
      "pt_BR",
      [],
    );
    expect(result.sent).toBe(1);
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("sent");
    expect(recipient.metaMessageId).toBe("wamid.abc");
    expect(getCampaignDoc(A).counters.sent).toBe(1);
  });
});

describe("Campanhas-06 — classificação de erro", () => {
  it("erro HTTP confirmado da Meta (não-transiente) é permanente", () => {
    const error = new Error('WhatsApp sendTemplate falhou: {"status":400,"code":131026}');
    expect(classifySendError(error)).toMatchObject({ kind: "permanent" });
  });

  it("throttling/rate-limit da Meta é classificado à parte", () => {
    const error = new Error('WhatsApp sendTemplate falhou: {"status":429,"code":4}');
    expect(classifySendError(error)).toMatchObject({ kind: "rate_limited" });
  });

  it("erro HTTP genérico confirmado da Meta é retryable", () => {
    const error = new Error('WhatsApp sendTemplate falhou: {"status":500,"code":1}');
    expect(classifySendError(error)).toMatchObject({ kind: "retryable" });
  });

  it("erro sem resposta HTTP confirmada (rede/timeout) é ambíguo, nunca retryable", () => {
    const error = new TypeError("fetch failed");
    expect(classifySendError(error)).toMatchObject({ kind: "ambiguous" });
  });
});

async function seedEligibleRecipient(id: string, phone: string, overrides: Partial<CampaignRecipient> = {}) {
  fakeDb.col(`establishments/${A}/customers`).set(phone, {
    phone,
    establishmentId: A,
    marketingStatus: "eligible",
    lastInteractionAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  seedRecipient(A, id, phone, overrides);
}

describe("Campanhas-06 — retry, permanente e ambíguo end-to-end", () => {
  it("erro retryable agenda retry e NÃO entra em loop imediato", async () => {
    await seedEligibleRecipient("r1", "5511999000005");
    sender.sendTemplate.mockRejectedValueOnce(new Error('WhatsApp sendTemplate falhou: {"status":500,"code":1}'));

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(result.retryScheduled).toBe(1);
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("queued");
    expect(recipient.attempts).toBe(1);
    expect(recipient.nextAttemptAt).toBeGreaterThan(Date.now() - 1000);
    expect(getCampaignDoc(A).counters.queued).toBe(1); // não é terminal
  });

  it("erro permanente falha direto, sem agendar retry", async () => {
    await seedEligibleRecipient("r1", "5511999000006");
    sender.sendTemplate.mockRejectedValueOnce(new Error('WhatsApp sendTemplate falhou: {"status":400,"code":131026}'));

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(result.failed).toBe(1);
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("failed");
    expect(recipient.ambiguous).toBeUndefined();
    expect(getCampaignDoc(A).counters.failed).toBe(1);
  });

  it("resultado ambíguo (sem resposta HTTP) nunca gera retry automático", async () => {
    await seedEligibleRecipient("r1", "5511999000007");
    sender.sendTemplate.mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(result.failed).toBe(1);
    expect(result.retryScheduled).toBe(0);
    const recipient = getRecipient(A, "r1");
    expect(recipient.status).toBe("failed");
    expect(recipient.ambiguous).toBe(true);

    // Uma invocação seguinte nunca tenta reenviar sozinha.
    sender.sendTemplate.mockClear();
    await dispatchCampaignBatch(A, CAMPAIGN_ID);
    expect(sender.sendTemplate).not.toHaveBeenCalled();
  });

  it("throttling/rate-limit interrompe o RESTO do lote imediatamente", async () => {
    await seedEligibleRecipient("r1", "5511999000008");
    await seedEligibleRecipient("r2", "5511999000009");
    seedCampaign(A, { counters: { total: 2, queued: 2, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 } });
    sender.sendTemplate.mockRejectedValueOnce(new Error('WhatsApp sendTemplate falhou: {"status":429,"code":4}'));

    await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(sender.sendTemplate).toHaveBeenCalledTimes(1); // não tentou o segundo
  });

  it("respeita o limite de attempts: acima do máximo, falha sem nova chamada de rede", async () => {
    await seedEligibleRecipient("r1", "5511999000010", { status: "queued", attempts: 5 });

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(getRecipient(A, "r1").failureReason).toBe("max_attempts_exceeded");
  });
});

describe("Campanhas-06 — precondições operacionais", () => {
  it("campanha fora de 'running' não processa nenhum recipient", async () => {
    seedCampaign(A, { status: "draft" });
    seedRecipient(A, "r1", "5511999000011");

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(result.aborted).toBe("campaign_not_running");
    expect(result.claimed).toBe(0);
  });

  it("WhatsApp não conectado aborta o lote inteiro sem reivindicar nada", async () => {
    seedEstablishment(A, { whatsapp: { ...CONNECTED_WA, status: "disconnected" } as never });
    seedRecipient(A, "r1", "5511999000012");

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID);

    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(result.aborted).toBe("whatsapp_not_connected");
    expect(getRecipient(A, "r1").status).toBe("pending"); // nunca chegou a ser reivindicado
  });

  it("campanha grande (muito acima do batchSize) processa só um lote por chamada", async () => {
    for (let i = 0; i < 45; i++) {
      await seedEligibleRecipient(`r${i}`, `551199900${String(i).padStart(4, "0")}`);
    }
    seedCampaign(A, { counters: { total: 45, queued: 45, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 } });
    sender.sendTemplate.mockResolvedValue({ waMessageId: "wamid.batch" });

    const result = await dispatchCampaignBatch(A, CAMPAIGN_ID, { batchSize: 20 });

    expect(result.claimed).toBe(20);
    expect(sender.sendTemplate).toHaveBeenCalledTimes(20);
    expect(getCampaignDoc(A).counters.sent).toBe(20);
    expect(getCampaignDoc(A).counters.queued).toBe(25);
  });

  it("scheduled futuro não processa e scheduled vencido pode iniciar", async () => {
    fakeDb.col(`establishments/${A}/customers`).set("5511999000013", {
      phone: "5511999000013", establishmentId: A, name: "Cliente", marketingStatus: "eligible",
      lastInteractionAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
    });
    seedRecipient(A, "r1", "5511999000013");
    seedCampaign(A, { status: "scheduled", scheduledAt: 2_000, counters: { total: 1, queued: 1, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 } });
    const early = await dispatchCampaignBatch(A, CAMPAIGN_ID, { now: 1_000 });
    expect(early.claimed).toBe(0);
    expect(sender.sendTemplate).not.toHaveBeenCalled();

    sender.sendTemplate.mockResolvedValue({ waMessageId: "wamid.scheduled" });
    const due = await dispatchCampaignBatch(A, CAMPAIGN_ID, { now: 2_000 });
    expect(due.sent).toBe(1);
    expect(sender.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
