import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  executeDurableWhatsAppOutbound,
  getWhatsAppOutboundIntent,
  OutboundReconciliationRequiredError,
} from "@/lib/whatsapp/outbox";

const input = {
  jobId: "wamid.outbound.1",
  establishmentId: "est",
  conversationId: "conv",
  leaseId: "lease",
  allowedStatuses: ["bot"] as const,
  toPhone: "5511999999999",
  whatsappPhoneNumberId: "pn-1",
  text: "Resposta durável",
  preferVoice: false,
};

beforeEach(() => {
  fakeDb.reset();
  fakeDb.col("establishments/est/conversations").set("conv", {
    id: "conv",
    establishmentId: "est",
    status: "bot",
    aiProcessingLease: { leaseId: "lease", acquiredAt: 1, expiresAt: 10_000 },
  });
});

describe("outbox durável do WhatsApp", () => {
  it("crash do caller após Meta aceitar não reenvia no replay", async () => {
    const sender = vi.fn(async () => ({ waMessageId: "wamid.meta.confirmed" }));
    await executeDurableWhatsAppOutbound({ ...input, allowedStatuses: [...input.allowedStatuses] }, sender, () => ({ code: "failed", ambiguous: false }), 100);

    // Simula crash antes de o caller concluir o inbound. A segunda execução
    // consulta o outbox confirmado em vez de chamar a Meta novamente.
    await expect(executeDurableWhatsAppOutbound({ ...input, allowedStatuses: [...input.allowedStatuses] }, sender, () => ({ code: "failed", ambiguous: false }), 101))
      .resolves.toEqual({ waMessageId: "wamid.meta.confirmed", text: "Resposta durável" });
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("resultado ambíguo exige reconciliação e nunca é reenviado automaticamente", async () => {
    const sender = vi.fn(async () => { throw new Error("timeout"); });
    await expect(executeDurableWhatsAppOutbound({ ...input, allowedStatuses: [...input.allowedStatuses] }, sender, () => ({ code: "text_send_ambiguous", ambiguous: true }), 100))
      .rejects.toBeInstanceOf(OutboundReconciliationRequiredError);
    expect((await getWhatsAppOutboundIntent(input.jobId))?.state).toBe("reconciliation_required");

    await expect(executeDurableWhatsAppOutbound({ ...input, allowedStatuses: [...input.allowedStatuses] }, sender, () => ({ code: "text_send_ambiguous", ambiguous: true }), 101))
      .rejects.toBeInstanceOf(OutboundReconciliationRequiredError);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("takeover humano antes do claim suprime o envio atomicamente", async () => {
    fakeDb.col("establishments/est/conversations").set("conv", {
      id: "conv", establishmentId: "est", status: "human", aiProcessingLease: null,
    });
    const sender = vi.fn(async () => ({ waMessageId: "should-not-send" }));
    await expect(executeDurableWhatsAppOutbound({ ...input, allowedStatuses: [...input.allowedStatuses] }, sender, () => ({ code: "failed", ambiguous: false }), 100))
      .resolves.toBeNull();
    expect(sender).not.toHaveBeenCalled();
  });
  it("prospectingAction sobrevive a crash/recovery e e retornada corretamente", async () => {
    const sender = vi.fn(async () => ({ waMessageId: "wamid.meta.confirmed" }));
    const intentWithAction = { ...input, allowedStatuses: [...input.allowedStatuses] as any, prospectingAction: { action: "reveal" } };
    
    await executeDurableWhatsAppOutbound(intentWithAction, sender, () => ({ code: "failed", ambiguous: false }), 100);
    
    // Verifica persistencia direta
    const persisted = await getWhatsAppOutboundIntent(input.jobId);
    expect(persisted?.prospectingAction).toEqual({ action: "reveal" });
    
    // Simula recovery sem chamar sender
    await expect(executeDurableWhatsAppOutbound(intentWithAction, sender, () => ({ code: "failed", ambiguous: false }), 101))
      .resolves.toEqual({ waMessageId: "wamid.meta.confirmed", text: "Resposta dur\u00E1vel" });
    expect(sender).toHaveBeenCalledTimes(1);
  });
});
