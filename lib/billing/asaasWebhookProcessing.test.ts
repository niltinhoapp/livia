import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EstablishmentBilling } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  processAsaasWebhookEvent,
  createAsaasWebhookProcessingDependencies,
  type AsaasWebhookProcessingDependencies,
  type AsaasWebhookProcessingResult,
  type ResolveAndApplyParams,
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

function envelope(over: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    event: "PAYMENT_RECEIVED",
    dateCreated: "2026-09-16 10:00:00",
    payment: { id: "pay_1", externalReference: REF_GEN1, value: 5 },
    ...over,
  };
}

beforeEach(() => {
  fakeDb.reset();
});

// ---------------------------------------------------------------------
// Camada 1: dispatch de processAsaasWebhookEvent (dependências mockadas,
// sem Firestore de verdade) — prova QUAL caminho é tomado para cada tipo
// de evento, e que ignored/unresolved_identity nunca chamam
// resolveAndApplyEvent (nunca tocam establishment/billing).
// ---------------------------------------------------------------------
describe("processAsaasWebhookEvent — dispatch", () => {
  function mockedDeps(overrides: Partial<AsaasWebhookProcessingDependencies> = {}): AsaasWebhookProcessingDependencies {
    const seen = new Set<string>();
    return {
      reserveEventId: vi.fn(async (eventId: string) => {
        if (seen.has(eventId)) return false;
        seen.add(eventId);
        return true;
      }),
      resolveAndApplyEvent: vi.fn(async (params: ResolveAndApplyParams): Promise<AsaasWebhookProcessingResult> => ({
        outcome: "applied",
        event: params.event,
        establishmentId: params.establishmentId,
        generation: params.generation,
        from: "trial",
        to: "active",
      })),
      now: () => 9_999,
      ...overrides,
    };
  }

  it("payload inválido -> invalid_envelope, sem tocar nenhuma dependência", async () => {
    const deps = mockedDeps();
    const result = await processAsaasWebhookEvent({ not: "an envelope" }, deps);
    expect(result).toEqual({ outcome: "invalid_envelope" });
    expect(deps.reserveEventId).not.toHaveBeenCalled();
    expect(deps.resolveAndApplyEvent).not.toHaveBeenCalled();
  });

  it("evento desconhecido -> ignored via reserveEventId, nunca chama resolveAndApplyEvent", async () => {
    const deps = mockedDeps();
    const result = await processAsaasWebhookEvent(envelope({ event: "PAYMENT_CREATED" }), deps);
    expect(result).toEqual({ outcome: "ignored", event: "PAYMENT_CREATED" });
    expect(deps.reserveEventId).toHaveBeenCalledWith("evt_1");
    expect(deps.resolveAndApplyEvent).not.toHaveBeenCalled();
  });

  it("SUBSCRIPTION_INACTIVATED -> ignored via reserveEventId, nunca chama resolveAndApplyEvent", async () => {
    const deps = mockedDeps();
    const result = await processAsaasWebhookEvent(
      envelope({ event: "SUBSCRIPTION_INACTIVATED", payment: undefined, subscription: { id: "sub_1", externalReference: REF_GEN1 } }),
      deps,
    );
    expect(result).toEqual({ outcome: "ignored", event: "SUBSCRIPTION_INACTIVATED" });
    expect(deps.resolveAndApplyEvent).not.toHaveBeenCalled();
  });

  it("evento duplicado (ignored) -> duplicate via reserveEventId", async () => {
    const deps = mockedDeps();
    await processAsaasWebhookEvent(envelope({ event: "PAYMENT_CREATED" }), deps);
    const second = await processAsaasWebhookEvent(envelope({ event: "PAYMENT_CREATED" }), deps);
    expect(second).toEqual({ outcome: "duplicate", eventId: "evt_1" });
  });

  it("externalReference ausente/malformado -> unresolved_identity via reserveEventId, nunca chama resolveAndApplyEvent", async () => {
    const deps = mockedDeps();
    const result = await processAsaasWebhookEvent(envelope({ payment: { id: "pay_1" } }), deps);
    expect(result).toEqual({ outcome: "unresolved_identity", event: "PAYMENT_RECEIVED" });
    expect(deps.resolveAndApplyEvent).not.toHaveBeenCalled();
  });

  it.each(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "SUBSCRIPTION_DELETED"])(
    "%s com identidade resolvida -> chama resolveAndApplyEvent com os params corretos",
    async (event) => {
      const deps = mockedDeps();
      await processAsaasWebhookEvent(envelope({ event }), deps);
      expect(deps.resolveAndApplyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: "evt_1",
          establishmentId: EST_ID,
          generation: 1,
          event,
          eventTimestamp: Date.UTC(2026, 8, 16, 10, 0, 0),
        }),
      );
      expect(deps.reserveEventId).not.toHaveBeenCalled(); // dedup é responsabilidade de resolveAndApplyEvent aqui
    },
  );

  it("nextDueDate do payload é repassado a resolveAndApplyEvent quando presente", async () => {
    const deps = mockedDeps();
    await processAsaasWebhookEvent(
      envelope({ event: "PAYMENT_CONFIRMED", payment: { id: "pay_1", externalReference: REF_GEN1, nextDueDate: "2026-12-01" } }),
      deps,
    );
    expect(deps.resolveAndApplyEvent).toHaveBeenCalledWith(expect.objectContaining({ nextDueDate: "2026-12-01" }));
  });

  it("resultado de resolveAndApplyEvent é repassado tal qual pelo processAsaasWebhookEvent", async () => {
    const deps = mockedDeps({
      resolveAndApplyEvent: vi.fn(async () => ({ outcome: "out_of_order" as const, event: "PAYMENT_OVERDUE", establishmentId: EST_ID, generation: 1 })),
    });
    const result = await processAsaasWebhookEvent(envelope({ event: "PAYMENT_OVERDUE" }), deps);
    expect(result).toEqual({ outcome: "out_of_order", event: "PAYMENT_OVERDUE", establishmentId: EST_ID, generation: 1 });
  });
});

// ---------------------------------------------------------------------
// Camada 2: resolveAndApplyEvent REAL (createAsaasWebhookProcessingDependencies
// contra fakeDb) — prova a atomicidade de verdade: dedup + leitura + decisão
// + escrita numa única transação Firestore.
// ---------------------------------------------------------------------
describe("resolveAndApplyEvent (real, via fakeDb) — decisões e transições", () => {
  async function seedEstablishment(id: string, billingOverride: Partial<EstablishmentBilling> = {}) {
    await fakeDb.collection("establishments").doc(id).set({ billing: billing(billingOverride) });
  }

  function params(over: Partial<ResolveAndApplyParams> = {}): ResolveAndApplyParams {
    return {
      eventId: "evt_1",
      establishmentId: EST_ID,
      generation: 1,
      event: "PAYMENT_CONFIRMED",
      domainEvent: "payment_confirmed",
      eventTimestamp: Date.UTC(2026, 8, 16, 10, 0, 0),
      ...over,
    };
  }

  it.each(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"] as const)("%s: trial -> active", async (event) => {
    await seedEstablishment(EST_ID, { billingStatus: "trial" });
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(params({ event, domainEvent: "payment_confirmed" }));
    expect(result).toMatchObject({ outcome: "applied", from: "trial", to: "active" });
    const stored = await fakeDb.collection("establishments").doc(EST_ID).get();
    expect((stored.data() as { billing: EstablishmentBilling }).billing.billingStatus).toBe("active");
  });

  it("PAYMENT_OVERDUE: active -> past_due", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "active" });
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(params({ event: "PAYMENT_OVERDUE", domainEvent: "payment_overdue" }));
    expect(result).toMatchObject({ outcome: "applied", from: "active", to: "past_due" });
  });

  it("SUBSCRIPTION_DELETED: active -> canceled", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "active" });
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(params({ event: "SUBSCRIPTION_DELETED", domainEvent: "cancel" }));
    expect(result).toMatchObject({ outcome: "applied", from: "active", to: "canceled" });
  });

  it("recontratação (generation=2): pagamento confirmado reativa um establishment canceled, sem intervenção manual", async () => {
    // OT de recontratação, item 5. subscriptionGeneration=2 já está gravado
    // ANTES deste webhook chegar — app/api/billing/subscribe/route.ts grava
    // isso de forma síncrona no sucesso do provisionamento, bem antes do
    // cliente pagar o Pix. O que prova reprovisionamento genuíno aqui é
    // params.generation bater exatamente com esse valor já persistido.
    await seedEstablishment(EST_ID, { billingStatus: "canceled", subscriptionGeneration: 2 });
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(
      params({ generation: 2, event: "PAYMENT_CONFIRMED", domainEvent: "payment_confirmed" }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: "canceled", to: "active", generation: 2 });
    const stored = await fakeDb.collection("establishments").doc(EST_ID).get();
    expect((stored.data() as { billing: EstablishmentBilling }).billing.billingStatus).toBe("active");
  });

  it("payment_confirmed para a geração 1 (nunca recontratada) NUNCA reativa um canceled — guard original preservado", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "canceled" }); // subscriptionGeneration ausente (== 1 implícito)
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(
      params({ generation: 1, event: "PAYMENT_CONFIRMED", domainEvent: "payment_confirmed" }),
    );
    expect(result).toMatchObject({ outcome: "invalid_transition", from: "canceled" });
  });

  it("replay de uma geração ANTIGA (já superada por outro ciclo cancelar+recontratar) nunca reativa", async () => {
    // establishment já recontratou uma vez (agora na geração 3) e cancelou
    // de novo; um evento atrasado da geração 2 (já obsoleta) chega depois.
    await seedEstablishment(EST_ID, { billingStatus: "canceled", subscriptionGeneration: 3 });
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(
      params({ generation: 2, event: "PAYMENT_CONFIRMED", domainEvent: "payment_confirmed" }),
    );
    expect(result).toMatchObject({ outcome: "invalid_transition", from: "canceled" });
  });

  it("payment_confirmed de geração>=2 fora do estado canceled segue o caminho normal (idempotente, já testado acima)", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "active", subscriptionGeneration: 2 });
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(
      params({ generation: 2, event: "PAYMENT_CONFIRMED", domainEvent: "payment_confirmed" }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: "active", to: "active" });
  });

  it("establishment inexistente -> establishment_not_found, sem marker definitivo (OT-06G.1/G.2, item 4)", async () => {
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(params());
    expect(result).toEqual({
      outcome: "establishment_not_found",
      event: "PAYMENT_CONFIRMED",
      establishmentId: EST_ID,
      generation: 1,
    });
    const dedupSnap = await fakeDb.collection("_processed_asaas_events").doc(params().eventId).get();
    expect(dedupSnap.exists).toBe(false);
  });

  it("billing nunca inicializado -> billing_not_initialized, nunca inventa estado inicial, sem marker definitivo (OT-06G.1/G.2, item 1)", async () => {
    await fakeDb.collection("establishments").doc(EST_ID).set({});
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(params());
    expect(result).toEqual({
      outcome: "billing_not_initialized",
      event: "PAYMENT_CONFIRMED",
      establishmentId: EST_ID,
      generation: 1,
    });
    const dedupSnap = await fakeDb.collection("_processed_asaas_events").doc(params().eventId).get();
    expect(dedupSnap.exists).toBe(false);
  });

  it("evento fora de ordem -> out_of_order, sem transição", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "active", lastAsaasEventAt: Date.UTC(2026, 8, 16, 12, 0, 0) });
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(params({ eventTimestamp: Date.UTC(2026, 8, 16, 10, 0, 0) }));
    expect(result).toMatchObject({ outcome: "out_of_order" });
  });

  it("transição inválida na tabela existente -> invalid_transition", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "canceled" });
    const deps = await createAsaasWebhookProcessingDependencies();
    const result = await deps.resolveAndApplyEvent(params({ event: "PAYMENT_OVERDUE", domainEvent: "payment_overdue" }));
    expect(result).toMatchObject({ outcome: "invalid_transition", from: "canceled" });
  });

  it("nextDueDate é persistido quando presente no evento", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "trial" });
    const deps = await createAsaasWebhookProcessingDependencies();
    await deps.resolveAndApplyEvent(params({ nextDueDate: "2026-12-01" }));
    const stored = await fakeDb.collection("establishments").doc(EST_ID).get();
    expect((stored.data() as { billing: EstablishmentBilling }).billing.nextDueDate).toBe("2026-12-01");
  });
});

// ---------------------------------------------------------------------
// Camada 2b: atomicidade dedup+transição (o próprio bloqueador B1) — os 6
// cenários exigidos pela OT-06G.
// ---------------------------------------------------------------------
describe("resolveAndApplyEvent — atomicidade dedup+transição (OT-06G, bloqueador B1)", () => {
  async function seedEstablishment(id: string, billingOverride: Partial<EstablishmentBilling> = {}) {
    await fakeDb.collection("establishments").doc(id).set({ billing: billing(billingOverride) });
  }

  function params(over: Partial<ResolveAndApplyParams> = {}): ResolveAndApplyParams {
    return {
      eventId: "evt_atomic_1",
      establishmentId: EST_ID,
      generation: 1,
      event: "PAYMENT_CONFIRMED",
      domainEvent: "payment_confirmed",
      eventTimestamp: Date.UTC(2026, 8, 16, 10, 0, 0),
      ...over,
    };
  }

  it("1) falha ANTES da transição (exceção dentro da transação) não queima o event.id", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "trial" });
    const deps = await createAsaasWebhookProcessingDependencies();

    const spy = vi.spyOn(fakeDb, "collection").mockImplementationOnce(() => {
      throw new Error("firestore indisponível");
    });
    await expect(deps.resolveAndApplyEvent(params())).rejects.toThrow("firestore indisponível");
    spy.mockRestore();

    const dedupSnap = await fakeDb.collection("_processed_asaas_events").doc("evt_atomic_1").get();
    expect(dedupSnap.exists).toBe(false); // nenhum marker órfão
  });

  it("2) retry após a falha (mesmo event.id) consegue processar normalmente", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "trial" });
    const deps = await createAsaasWebhookProcessingDependencies();

    const spy = vi.spyOn(fakeDb, "collection").mockImplementationOnce(() => {
      throw new Error("firestore indisponível");
    });
    await expect(deps.resolveAndApplyEvent(params())).rejects.toThrow();
    spy.mockRestore();

    const retry = await deps.resolveAndApplyEvent(params());
    expect(retry).toMatchObject({ outcome: "applied", from: "trial", to: "active" });
  });

  it("3) duas entregas concorrentes do mesmo event.id: só uma aplica, a outra vira duplicate", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "trial" });
    const deps = await createAsaasWebhookProcessingDependencies();

    const [r1, r2] = await Promise.all([
      deps.resolveAndApplyEvent(params()),
      deps.resolveAndApplyEvent(params()),
    ]);

    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(["applied", "duplicate"]);

    const stored = await fakeDb.collection("establishments").doc(EST_ID).get();
    expect((stored.data() as { billing: EstablishmentBilling }).billing.billingStatus).toBe("active"); // transicionou só uma vez
  });

  it("4) duplicate após processamento bem-sucedido: segunda chamada sequencial não reaplica", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "trial" });
    const deps = await createAsaasWebhookProcessingDependencies();

    const first = await deps.resolveAndApplyEvent(params());
    expect(first).toMatchObject({ outcome: "applied" });

    const second = await deps.resolveAndApplyEvent(params());
    expect(second).toEqual({ outcome: "duplicate", eventId: "evt_atomic_1" });
  });

  it("5) falha da transação não deixa marker órfão, mesmo quando a decisão seria 'ignorar' (ex.: billing_not_initialized)", async () => {
    // Sem seed de establishment (nem doc, nem billing) — a leitura falha
    // antes de a transação decidir o que fazer.
    const deps = await createAsaasWebhookProcessingDependencies();
    const spy = vi.spyOn(fakeDb, "collection").mockImplementationOnce(() => {
      throw new Error("firestore indisponível");
    });
    await expect(deps.resolveAndApplyEvent(params())).rejects.toThrow();
    spy.mockRestore();

    const dedupSnap = await fakeDb.collection("_processed_asaas_events").doc("evt_atomic_1").get();
    expect(dedupSnap.exists).toBe(false);
  });

  it("6) eventos ignored (fora deste caminho atômico) continuam deliberados: dedup simples, sem tentar ler establishment", async () => {
    // Regressão: SUBSCRIPTION_INACTIVATED e eventos desconhecidos nunca
    // chegam a resolveAndApplyEvent (ver describe "dispatch" acima) — este
    // teste confirma que o dedup simples (reserveEventId) continua
    // funcionando corretamente mesmo depois da mudança de B1.
    const deps = await createAsaasWebhookProcessingDependencies();
    const first = await deps.reserveEventId("evt_ignored_1");
    expect(first).toBe(true);
    const second = await deps.reserveEventId("evt_ignored_1");
    expect(second).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Camada 2c: outcomes transitórios vs. terminais (OT-06G.1/G.2) — os 9
// cenários de regressão exigidos pela OT-06G.2.
// ---------------------------------------------------------------------
describe("resolveAndApplyEvent — terminal vs. transitório (OT-06G.1/G.2)", () => {
  async function seedEstablishment(id: string, billingOverride: Partial<EstablishmentBilling> = {}) {
    await fakeDb.collection("establishments").doc(id).set({ billing: billing(billingOverride) });
  }

  function params(over: Partial<ResolveAndApplyParams> = {}): ResolveAndApplyParams {
    return {
      eventId: "evt_transitorio_1",
      establishmentId: EST_ID,
      generation: 1,
      event: "PAYMENT_CONFIRMED",
      domainEvent: "payment_confirmed",
      eventTimestamp: Date.UTC(2026, 8, 16, 10, 0, 0),
      ...over,
    };
  }

  it("2) billing_not_initialized: retry do mesmo event.id continua possível (não fica preso em duplicate)", async () => {
    await fakeDb.collection("establishments").doc(EST_ID).set({});
    const deps = await createAsaasWebhookProcessingDependencies();

    const first = await deps.resolveAndApplyEvent(params());
    expect(first).toMatchObject({ outcome: "billing_not_initialized" });

    const retry = await deps.resolveAndApplyEvent(params());
    expect(retry).toMatchObject({ outcome: "billing_not_initialized" }); // continua sendo reprocessado, nunca "duplicate"
  });

  it("3) após inicializar billing, o MESMO event.id aplica a transição e então cria marker", async () => {
    await fakeDb.collection("establishments").doc(EST_ID).set({});
    const deps = await createAsaasWebhookProcessingDependencies();

    const first = await deps.resolveAndApplyEvent(params());
    expect(first).toMatchObject({ outcome: "billing_not_initialized" });
    let dedupSnap = await fakeDb.collection("_processed_asaas_events").doc("evt_transitorio_1").get();
    expect(dedupSnap.exists).toBe(false);

    await seedEstablishment(EST_ID, { billingStatus: "trial" });

    const second = await deps.resolveAndApplyEvent(params());
    expect(second).toMatchObject({ outcome: "applied", from: "trial", to: "active" });
    dedupSnap = await fakeDb.collection("_processed_asaas_events").doc("evt_transitorio_1").get();
    expect(dedupSnap.exists).toBe(true);

    const thirdSameId = await deps.resolveAndApplyEvent(params());
    expect(thirdSameId).toEqual({ outcome: "duplicate", eventId: "evt_transitorio_1" }); // agora sim vira duplicate
  });

  it("5) após criar establishment + billing (partindo de establishment_not_found), o MESMO event.id aplica e cria marker", async () => {
    const deps = await createAsaasWebhookProcessingDependencies();

    const first = await deps.resolveAndApplyEvent(params());
    expect(first).toMatchObject({ outcome: "establishment_not_found" });
    let dedupSnap = await fakeDb.collection("_processed_asaas_events").doc("evt_transitorio_1").get();
    expect(dedupSnap.exists).toBe(false);

    await seedEstablishment(EST_ID, { billingStatus: "trial" });

    const second = await deps.resolveAndApplyEvent(params());
    expect(second).toMatchObject({ outcome: "applied", from: "trial", to: "active" });
    dedupSnap = await fakeDb.collection("_processed_asaas_events").doc("evt_transitorio_1").get();
    expect(dedupSnap.exists).toBe(true);
  });

  it("6) out_of_order continua terminal/deduplicável: retry do mesmo event.id vira duplicate, não reaplica", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "active", lastAsaasEventAt: Date.UTC(2026, 8, 16, 12, 0, 0) });
    const deps = await createAsaasWebhookProcessingDependencies();

    const first = await deps.resolveAndApplyEvent(params({ eventTimestamp: Date.UTC(2026, 8, 16, 10, 0, 0) }));
    expect(first).toMatchObject({ outcome: "out_of_order" });

    const retry = await deps.resolveAndApplyEvent(params({ eventTimestamp: Date.UTC(2026, 8, 16, 10, 0, 0) }));
    expect(retry).toEqual({ outcome: "duplicate", eventId: "evt_transitorio_1" });
  });

  it("7) invalid_transition continua terminal/deduplicável: retry do mesmo event.id vira duplicate, não reaplica", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "canceled" });
    const deps = await createAsaasWebhookProcessingDependencies();

    const first = await deps.resolveAndApplyEvent(params({ event: "PAYMENT_OVERDUE", domainEvent: "payment_overdue" }));
    expect(first).toMatchObject({ outcome: "invalid_transition", from: "canceled" });

    const retry = await deps.resolveAndApplyEvent(params({ event: "PAYMENT_OVERDUE", domainEvent: "payment_overdue" }));
    expect(retry).toEqual({ outcome: "duplicate", eventId: "evt_transitorio_1" });
  });

  it("8) falha transacional durante um caso que resultaria em establishment_not_found continua sem marker órfão", async () => {
    // Regressão explícita do teste 5 do bloco B1 acima, agora nomeada em
    // termos da OT-06G.2: mesmo outcome transitório, mesma garantia.
    const deps = await createAsaasWebhookProcessingDependencies();
    const spy = vi.spyOn(fakeDb, "collection").mockImplementationOnce(() => {
      throw new Error("firestore indisponível");
    });
    await expect(deps.resolveAndApplyEvent(params())).rejects.toThrow();
    spy.mockRestore();

    const dedupSnap = await fakeDb.collection("_processed_asaas_events").doc("evt_transitorio_1").get();
    expect(dedupSnap.exists).toBe(false);
  });

  it("9) concorrência em cima de um outcome terminal (invalid_transition) garante uma aplicação da decisão e uma duplicate", async () => {
    await seedEstablishment(EST_ID, { billingStatus: "canceled" });
    const deps = await createAsaasWebhookProcessingDependencies();

    const [r1, r2] = await Promise.all([
      deps.resolveAndApplyEvent(params({ event: "PAYMENT_OVERDUE", domainEvent: "payment_overdue" })),
      deps.resolveAndApplyEvent(params({ event: "PAYMENT_OVERDUE", domainEvent: "payment_overdue" })),
    ]);

    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(["duplicate", "invalid_transition"]);
  });
});
