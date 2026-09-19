import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { db: fake.fakeDb };
});

import { logicalSubscriptionExternalReference } from "./provisioning";
import {
  extractCheckoutSession,
  extractExternalReference,
  extractNextDueDate,
  extractSubscriptionId,
  isRecognizedNoTransitionEvent,
  parseAsaasEventTimestamp,
  parseAsaasWebhookEnvelope,
  resolveEstablishmentFromExternalReference,
  translateAsaasEvent,
} from "./asaasWebhookEvents";

describe("parseAsaasWebhookEnvelope", () => {
  it("aceita envelope válido de payment", () => {
    const result = parseAsaasWebhookEnvelope({
      id: "evt_1",
      event: "PAYMENT_RECEIVED",
      dateCreated: "2026-09-16 10:00:00",
      payment: { id: "pay_1", externalReference: "livia:subscription:est_1:1" },
    });
    expect(result).toEqual({
      id: "evt_1",
      event: "PAYMENT_RECEIVED",
      dateCreatedRaw: "2026-09-16 10:00:00",
      data: { id: "pay_1", externalReference: "livia:subscription:est_1:1" },
    });
  });

  it("aceita envelope válido de subscription", () => {
    const result = parseAsaasWebhookEnvelope({
      id: "evt_2",
      event: "SUBSCRIPTION_DELETED",
      dateCreated: "2026-09-16 10:00:00",
      subscription: { id: "sub_1" },
    });
    expect(result?.data).toEqual({ id: "sub_1" });
  });

  it("aceita envelope sem payment nem subscription (data: null)", () => {
    const result = parseAsaasWebhookEnvelope({
      id: "evt_3",
      event: "SOME_OTHER_EVENT",
      dateCreated: "2026-09-16 10:00:00",
    });
    expect(result).toEqual({
      id: "evt_3",
      event: "SOME_OTHER_EVENT",
      dateCreatedRaw: "2026-09-16 10:00:00",
      data: null,
    });
  });

  it.each([
    ["não é objeto", "string"],
    ["null", null],
    ["array", []],
    ["sem id", { event: "X", dateCreated: "2026-09-16 10:00:00" }],
    ["id vazio", { id: "", event: "X", dateCreated: "2026-09-16 10:00:00" }],
    ["sem event", { id: "evt_1", dateCreated: "2026-09-16 10:00:00" }],
    ["sem dateCreated", { id: "evt_1", event: "X" }],
    ["dateCreated não-string", { id: "evt_1", event: "X", dateCreated: 123 }],
  ])("rejeita payload malformado: %s", (_label, raw) => {
    expect(parseAsaasWebhookEnvelope(raw)).toBeNull();
  });
});

describe("parseAsaasEventTimestamp", () => {
  it("parseia formato documentado YYYY-MM-DD HH:mm:ss como UTC", () => {
    expect(parseAsaasEventTimestamp("2026-09-16 10:00:00")).toBe(Date.UTC(2026, 8, 16, 10, 0, 0));
  });

  it.each([
    ["formato ISO com T", "2026-09-16T10:00:00Z"],
    ["data inválida", "not-a-date"],
    ["ausente", undefined],
    ["número", 123],
  ])("retorna null para %s", (_label, value) => {
    expect(parseAsaasEventTimestamp(value)).toBeNull();
  });
});

describe("translateAsaasEvent", () => {
  it.each([
    ["PAYMENT_CONFIRMED", "payment_confirmed"],
    ["PAYMENT_RECEIVED", "payment_confirmed"],
    ["PAYMENT_OVERDUE", "payment_overdue"],
    ["SUBSCRIPTION_DELETED", "cancel"],
  ])("%s -> %s", (asaasEvent, expected) => {
    expect(translateAsaasEvent(asaasEvent)).toBe(expected);
  });

  it("SUBSCRIPTION_INACTIVATED não produz nenhum BillingEventType (decisão deliberada)", () => {
    expect(translateAsaasEvent("SUBSCRIPTION_INACTIVATED")).toBeNull();
  });

  it.each(["PAYMENT_CREATED", "SUBSCRIPTION_UPDATED", "EVENTO_INEXISTENTE"])(
    "evento desconhecido (%s) retorna null",
    (event) => {
      expect(translateAsaasEvent(event)).toBeNull();
    },
  );
});

describe("isRecognizedNoTransitionEvent", () => {
  it("true só para SUBSCRIPTION_INACTIVATED", () => {
    expect(isRecognizedNoTransitionEvent("SUBSCRIPTION_INACTIVATED")).toBe(true);
    expect(isRecognizedNoTransitionEvent("PAYMENT_CREATED")).toBe(false);
  });
});

describe("resolveEstablishmentFromExternalReference", () => {
  it("round-trip com logicalSubscriptionExternalReference (mesmo formato usado na criação)", () => {
    const ref = logicalSubscriptionExternalReference("est_recovery_1", 4);
    expect(resolveEstablishmentFromExternalReference(ref)).toEqual({
      establishmentId: "est_recovery_1",
      generation: 4,
    });
  });

  it("establishmentId pode conter hífens (formato real usado no harness)", () => {
    const ref = "livia:subscription:asaas-sandbox-test-livia-homologacao-001:5";
    expect(resolveEstablishmentFromExternalReference(ref)).toEqual({
      establishmentId: "asaas-sandbox-test-livia-homologacao-001",
      generation: 5,
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["número", 123],
    ["string vazia", ""],
    ["sem prefixo", "sub_1"],
    ["prefixo errado", "outro:subscription:est_1:1"],
    ["generation ausente", "livia:subscription:est_1:"],
    ["generation não-numérica", "livia:subscription:est_1:abc"],
    ["generation zero", "livia:subscription:est_1:0"],
    ["generation negativa", "livia:subscription:est_1:-1"],
    ["establishmentId vazio", "livia:subscription::1"],
    ["sem generation nenhuma", "livia:subscription:est_1"],
  ])("fail-closed: %s -> null", (_label, value) => {
    expect(resolveEstablishmentFromExternalReference(value)).toBeNull();
  });
});

describe("extractExternalReference / extractNextDueDate", () => {
  it("extractExternalReference lê o campo do data object", () => {
    expect(extractExternalReference({ externalReference: "livia:subscription:est_1:1" })).toBe(
      "livia:subscription:est_1:1",
    );
    expect(extractExternalReference(null)).toBeUndefined();
    expect(extractExternalReference({})).toBeUndefined();
  });

  it("extractNextDueDate só aceita string não-vazia", () => {
    expect(extractNextDueDate({ nextDueDate: "2026-12-01" })).toBe("2026-12-01");
    expect(extractNextDueDate({ nextDueDate: "" })).toBeUndefined();
    expect(extractNextDueDate({ nextDueDate: 123 })).toBeUndefined();
    expect(extractNextDueDate(null)).toBeUndefined();
    expect(extractNextDueDate({})).toBeUndefined();
  });

  it("nunca confunde payment.dueDate (cobrança específica) com nextDueDate (assinatura)", () => {
    // payment webhook payload real não tem nextDueDate — só dueDate.
    expect(extractNextDueDate({ dueDate: "2026-12-01", value: 5 })).toBeUndefined();
  });

  it("extractCheckoutSession só aceita string não-vazia", () => {
    expect(extractCheckoutSession({ checkoutSession: "a0871e16-1bdf-4f9f-91dc-5963e4588e85" })).toBe(
      "a0871e16-1bdf-4f9f-91dc-5963e4588e85",
    );
    expect(extractCheckoutSession({ checkoutSession: "" })).toBeNull();
    expect(extractCheckoutSession({ checkoutSession: 123 })).toBeNull();
    expect(extractCheckoutSession({ checkoutSession: null })).toBeNull();
    expect(extractCheckoutSession(null)).toBeNull();
    expect(extractCheckoutSession({})).toBeNull();
  });

  it("extractSubscriptionId só aceita string não-vazia (payment.subscription)", () => {
    expect(extractSubscriptionId({ subscription: "sub_umsscnlkbirwmv6w" })).toBe("sub_umsscnlkbirwmv6w");
    expect(extractSubscriptionId({ subscription: "" })).toBeNull();
    expect(extractSubscriptionId({ subscription: 123 })).toBeNull();
    expect(extractSubscriptionId(null)).toBeNull();
    expect(extractSubscriptionId({})).toBeNull();
  });
});
