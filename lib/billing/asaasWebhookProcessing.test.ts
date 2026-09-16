import { describe, expect, it, vi } from "vitest";
import type { BillingStatus, EstablishmentBilling } from "@/types";
import {
  processAsaasWebhookEvent,
  type AsaasWebhookProcessingDependencies,
  type EstablishmentBillingLookup,
} from "./asaasWebhookProcessing";

const EST_ID = "est_webhook_1";
const REF_GEN1 = `livia:subscription:${EST_ID}:1`;

function billing(over: Partial<EstablishmentBilling> = {}): EstablishmentBilling {
  return {
    billingStatus: "trial",
    updatedAt: 1,
    ...over,
  };
}

function deps(
  billingLookup: EstablishmentBillingLookup,
  overrides: Partial<AsaasWebhookProcessingDependencies> = {},
): AsaasWebhookProcessingDependencies {
  const seen = new Set<string>();
  return {
    reserveEventId: vi.fn(async (eventId: string) => {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      return true;
    }),
    getEstablishmentBilling: vi.fn(async () => billingLookup),
    applyBillingTransition: vi.fn(async () => {}),
    now: () => 9_999,
    ...overrides,
  };
}

function envelope(over: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    event: "PAYMENT_RECEIVED",
    dateCreated: "2026-09-16 10:00:00",
    payment: { id: "pay_1", externalReference: REF_GEN1, value: 5 },
    ...over,
  };
}

describe("processAsaasWebhookEvent — validação e dedup", () => {
  it("payload inválido -> invalid_envelope, sem tentar dedup", async () => {
    const d = deps({ found: false });
    const result = await processAsaasWebhookEvent({ not: "an envelope" }, d);
    expect(result).toEqual({ outcome: "invalid_envelope" });
    expect(d.reserveEventId).not.toHaveBeenCalled();
  });

  it("event.id duplicado -> duplicate, sem tocar billing", async () => {
    const d = deps({ found: true, billing: billing() });
    await processAsaasWebhookEvent(envelope(), d);
    const second = await processAsaasWebhookEvent(envelope(), d);
    expect(second).toEqual({ outcome: "duplicate", eventId: "evt_1" });
    expect(d.applyBillingTransition).toHaveBeenCalledTimes(1); // só a 1ª chamada
  });
});

describe("processAsaasWebhookEvent — PAYMENT_CONFIRMED / PAYMENT_RECEIVED", () => {
  it.each(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"])("%s: trial -> active", async (event) => {
    const d = deps({ found: true, billing: billing({ billingStatus: "trial" }) });
    const result = await processAsaasWebhookEvent(envelope({ event }), d);
    expect(result).toMatchObject({ outcome: "applied", event, from: "trial", to: "active" });
    expect(d.applyBillingTransition).toHaveBeenCalledWith(EST_ID, {
      billingStatus: "active",
      lastAsaasEventAt: Date.UTC(2026, 8, 16, 10, 0, 0),
      nextDueDate: undefined,
    });
  });

  it("PAYMENT_CONFIRMED em past_due -> active (recuperação de inadimplência)", async () => {
    const d = deps({ found: true, billing: billing({ billingStatus: "past_due" }) });
    const result = await processAsaasWebhookEvent(envelope({ event: "PAYMENT_CONFIRMED" }), d);
    expect(result).toMatchObject({ outcome: "applied", from: "past_due", to: "active" });
  });
});

describe("processAsaasWebhookEvent — PAYMENT_OVERDUE", () => {
  it("active -> past_due", async () => {
    const d = deps({ found: true, billing: billing({ billingStatus: "active" }) });
    const result = await processAsaasWebhookEvent(envelope({ event: "PAYMENT_OVERDUE" }), d);
    expect(result).toMatchObject({ outcome: "applied", from: "active", to: "past_due" });
  });
});

describe("processAsaasWebhookEvent — SUBSCRIPTION_DELETED", () => {
  it("active -> canceled", async () => {
    const d = deps({ found: true, billing: billing({ billingStatus: "active" }) });
    const result = await processAsaasWebhookEvent(
      envelope({ event: "SUBSCRIPTION_DELETED", payment: undefined, subscription: { id: "sub_1", externalReference: REF_GEN1 } }),
      d,
    );
    expect(result).toMatchObject({ outcome: "applied", from: "active", to: "canceled" });
  });
});

describe("processAsaasWebhookEvent — SUBSCRIPTION_INACTIVATED (sem transição por decisão)", () => {
  it("reconhecido, deduplicado, mas billingStatus permanece intocado", async () => {
    const d = deps({ found: true, billing: billing({ billingStatus: "active" }) });
    const result = await processAsaasWebhookEvent(
      envelope({ event: "SUBSCRIPTION_INACTIVATED", payment: undefined, subscription: { id: "sub_1", externalReference: REF_GEN1 } }),
      d,
    );
    expect(result).toEqual({ outcome: "ignored", event: "SUBSCRIPTION_INACTIVATED" });
    expect(d.applyBillingTransition).not.toHaveBeenCalled();
  });
});

describe("processAsaasWebhookEvent — evento desconhecido", () => {
  it("reconhecido/deduplicado, sem transição, sem resolver identidade", async () => {
    const d = deps({ found: true, billing: billing() });
    const result = await processAsaasWebhookEvent(envelope({ event: "PAYMENT_CREATED" }), d);
    expect(result).toEqual({ outcome: "ignored", event: "PAYMENT_CREATED" });
    expect(d.getEstablishmentBilling).not.toHaveBeenCalled();
    expect(d.applyBillingTransition).not.toHaveBeenCalled();
  });
});

describe("processAsaasWebhookEvent — externalReference ausente/malformado (fail-closed)", () => {
  it.each([
    ["ausente", { id: "pay_1" }],
    ["null", { id: "pay_1", externalReference: null }],
    ["formato errado", { id: "pay_1", externalReference: "algo-qualquer" }],
    ["prefixo errado", { id: "pay_1", externalReference: "outro:subscription:est_1:1" }],
  ])("%s -> unresolved_identity, sem tocar billing", async (_label, payment) => {
    const d = deps({ found: true, billing: billing() });
    const result = await processAsaasWebhookEvent(envelope({ payment }), d);
    expect(result).toEqual({ outcome: "unresolved_identity", event: "PAYMENT_RECEIVED" });
    expect(d.getEstablishmentBilling).not.toHaveBeenCalled();
    expect(d.applyBillingTransition).not.toHaveBeenCalled();
  });
});

describe("processAsaasWebhookEvent — establishment/billing ausentes", () => {
  it("establishment inexistente -> establishment_not_found", async () => {
    const d = deps({ found: false });
    const result = await processAsaasWebhookEvent(envelope(), d);
    expect(result).toEqual({
      outcome: "establishment_not_found",
      event: "PAYMENT_RECEIVED",
      establishmentId: EST_ID,
      generation: 1,
    });
  });

  it("billing nunca inicializado -> billing_not_initialized, nunca inventa estado inicial", async () => {
    const d = deps({ found: true, billing: null });
    const result = await processAsaasWebhookEvent(envelope(), d);
    expect(result).toEqual({
      outcome: "billing_not_initialized",
      event: "PAYMENT_RECEIVED",
      establishmentId: EST_ID,
      generation: 1,
    });
  });
});

describe("processAsaasWebhookEvent — evento fora de ordem", () => {
  it("dateCreated <= lastAsaasEventAt já persistido -> out_of_order, sem transição", async () => {
    const d = deps({
      found: true,
      billing: billing({ billingStatus: "active", lastAsaasEventAt: Date.UTC(2026, 8, 16, 12, 0, 0) }),
    });
    const result = await processAsaasWebhookEvent(
      envelope({ dateCreated: "2026-09-16 10:00:00" }), // mais antigo que lastAsaasEventAt
      d,
    );
    expect(result).toEqual({
      outcome: "out_of_order",
      event: "PAYMENT_RECEIVED",
      establishmentId: EST_ID,
      generation: 1,
    });
    expect(d.applyBillingTransition).not.toHaveBeenCalled();
  });

  it("dateCreated igual ao lastAsaasEventAt também é descartado (não estritamente mais novo)", async () => {
    const ts = Date.UTC(2026, 8, 16, 10, 0, 0);
    const d = deps({ found: true, billing: billing({ billingStatus: "active", lastAsaasEventAt: ts }) });
    const result = await processAsaasWebhookEvent(envelope({ dateCreated: "2026-09-16 10:00:00" }), d);
    expect(result).toMatchObject({ outcome: "out_of_order" });
  });

  it("dateCreated mais novo que lastAsaasEventAt -> aplica normalmente", async () => {
    const d = deps({
      found: true,
      billing: billing({ billingStatus: "active", lastAsaasEventAt: Date.UTC(2026, 8, 16, 9, 0, 0) }),
    });
    const result = await processAsaasWebhookEvent(envelope({ dateCreated: "2026-09-16 10:00:00" }), d);
    expect(result).toMatchObject({ outcome: "applied" });
  });
});

describe("processAsaasWebhookEvent — transição inválida na tabela existente", () => {
  it("PAYMENT_OVERDUE em canceled -> invalid_transition, fail-closed", async () => {
    const d = deps({ found: true, billing: billing({ billingStatus: "canceled" }) });
    const result = await processAsaasWebhookEvent(envelope({ event: "PAYMENT_OVERDUE" }), d);
    expect(result).toEqual({
      outcome: "invalid_transition",
      event: "PAYMENT_OVERDUE",
      establishmentId: EST_ID,
      generation: 1,
      from: "canceled",
    });
    expect(d.applyBillingTransition).not.toHaveBeenCalled();
  });
});

describe("processAsaasWebhookEvent — nextDueDate", () => {
  it("subscription payload com nextDueDate persiste o campo", async () => {
    const d = deps({ found: true, billing: billing({ billingStatus: "active" }) });
    await processAsaasWebhookEvent(
      envelope({
        event: "PAYMENT_CONFIRMED",
        payment: { id: "pay_1", externalReference: REF_GEN1, nextDueDate: "2026-12-01" },
      }),
      d,
    );
    expect(d.applyBillingTransition).toHaveBeenCalledWith(
      EST_ID,
      expect.objectContaining({ nextDueDate: "2026-12-01" }),
    );
  });

  it("payment payload real (sem nextDueDate) não seta o campo", async () => {
    const d = deps({ found: true, billing: billing({ billingStatus: "active" }) });
    await processAsaasWebhookEvent(
      envelope({ payment: { id: "pay_1", externalReference: REF_GEN1, dueDate: "2026-12-01", value: 5 } }),
      d,
    );
    expect(d.applyBillingTransition).toHaveBeenCalledWith(
      EST_ID,
      expect.objectContaining({ nextDueDate: undefined }),
    );
  });
});

describe("garantia estrutural — billingProvisioning nunca é tocado por este módulo", () => {
  it("provisioning.phase === succeeded NUNCA, sozinho, ativa billing (módulos são fisicamente separados)", async () => {
    // Este teste documenta a garantia por AUSÊNCIA: processAsaasWebhookEvent
    // não importa provisioning.ts (exceto o teste de round-trip de
    // externalReference no outro arquivo), não lê billingProvisioning/*, e
    // sua única fonte de verdade para o billingStatus ATUAL é
    // deps.getEstablishmentBilling — nunca deps.getProvisioningIntent (que
    // nem existe nesta interface). Compilar sem esse método na interface já
    // é a prova: TypeScript não permitiria chamar algo que não existe.
    const d = deps({ found: true, billing: billing({ billingStatus: "trial" }) });
    expect("getProvisioningIntent" in d).toBe(false);
    expect("recoverConflict" in d).toBe(false);
    const result = await processAsaasWebhookEvent(envelope({ event: "PAYMENT_CONFIRMED" }), d);
    expect(result).toMatchObject({ outcome: "applied", to: "active" });
  });

  it("um evento de payment nunca causa efeito colateral em conflictSubscriptionIds/externalSubscriptionId de provisioning (campos nem existem no patch)", async () => {
    const d = deps({ found: true, billing: billing({ billingStatus: "trial" }) });
    await processAsaasWebhookEvent(envelope({ event: "PAYMENT_CONFIRMED" }), d);
    const patch = vi.mocked(d.applyBillingTransition).mock.calls[0]?.[1];
    expect(patch).not.toHaveProperty("externalSubscriptionId");
    expect(patch).not.toHaveProperty("phase");
    expect(patch).not.toHaveProperty("conflictSubscriptionIds");
  });
});
