// Orquestração do processamento de um evento de Webhook Asaas (OT-06C).
// Só esta camada faz I/O (via dependências injetadas, mesmo padrão de
// ProvisioningDependencies/ConflictRecoveryDependencies) — a tradução em si
// (asaasWebhookEvents.ts) e a máquina de estados (stateMachine.ts)
// permanecem puras e intocadas.
//
// Isolamento estrito (contrato OT-06B, itens 13-15):
//   - Nunca lê nem escreve billingProvisioning/* — só establishments/{id}.billing.
//   - Nunca conecta canUseService() a rota nenhuma.
//   - Nunca toca panelAccess, whatsapp, whatsappBeta, status.
import type { BillingStatus, EstablishmentBilling } from "@/types";
import { nextBillingStatus } from "./stateMachine";
import {
  parseAsaasWebhookEnvelope,
  parseAsaasEventTimestamp,
  translateAsaasEvent,
  resolveEstablishmentFromExternalReference,
  extractExternalReference,
  extractNextDueDate,
} from "./asaasWebhookEvents";

export type EstablishmentBillingLookup =
  | { found: true; billing: EstablishmentBilling | null }
  | { found: false };

export interface AsaasWebhookProcessingDependencies {
  // true = reservado agora (primeira vez visto); false = event.id duplicado.
  reserveEventId: (eventId: string) => Promise<boolean>;
  getEstablishmentBilling: (establishmentId: string) => Promise<EstablishmentBillingLookup>;
  applyBillingTransition: (
    establishmentId: string,
    patch: { billingStatus: BillingStatus; lastAsaasEventAt: number; nextDueDate?: string },
  ) => Promise<void>;
  now: () => number;
}

export type AsaasWebhookProcessingResult =
  | { outcome: "invalid_envelope" }
  | { outcome: "duplicate"; eventId: string }
  | { outcome: "unresolved_identity"; event: string }
  | { outcome: "establishment_not_found"; event: string; establishmentId: string; generation: number }
  // est.billing nunca foi inicializado (nenhuma rota de onboarding faz isso
  // ainda — OT-06A). Fail-closed: nunca inventa um billingStatus inicial.
  | { outcome: "billing_not_initialized"; event: string; establishmentId: string; generation: number }
  // Cobre tanto eventos totalmente desconhecidos quanto
  // SUBSCRIPTION_INACTIVATED (reconhecido, sem transição por decisão — ver
  // asaasWebhookEvents.ts).
  | { outcome: "ignored"; event: string }
  | { outcome: "out_of_order"; event: string; establishmentId: string; generation: number }
  | { outcome: "invalid_transition"; event: string; establishmentId: string; generation: number; from: BillingStatus }
  | { outcome: "applied"; event: string; establishmentId: string; generation: number; from: BillingStatus; to: BillingStatus };

export async function processAsaasWebhookEvent(
  rawBody: unknown,
  deps: AsaasWebhookProcessingDependencies,
): Promise<AsaasWebhookProcessingResult> {
  const envelope = parseAsaasWebhookEnvelope(rawBody);
  if (!envelope) return { outcome: "invalid_envelope" };

  const isNew = await deps.reserveEventId(envelope.id);
  if (!isNew) return { outcome: "duplicate", eventId: envelope.id };

  const domainEvent = translateAsaasEvent(envelope.event);
  if (!domainEvent) {
    return { outcome: "ignored", event: envelope.event };
  }

  // Resolução de identidade só acontece para eventos que realmente
  // produzem transição — nunca lookup adicional na Asaas, nunca adivinha
  // por customer/subscription (contrato OT-06B item 9).
  const identity = resolveEstablishmentFromExternalReference(extractExternalReference(envelope.data));
  if (!identity) {
    return { outcome: "unresolved_identity", event: envelope.event };
  }

  const lookup = await deps.getEstablishmentBilling(identity.establishmentId);
  if (!lookup.found) {
    return {
      outcome: "establishment_not_found",
      event: envelope.event,
      establishmentId: identity.establishmentId,
      generation: identity.generation,
    };
  }
  if (!lookup.billing) {
    return {
      outcome: "billing_not_initialized",
      event: envelope.event,
      establishmentId: identity.establishmentId,
      generation: identity.generation,
    };
  }

  const eventTimestamp = parseAsaasEventTimestamp(envelope.dateCreatedRaw);
  if (
    eventTimestamp !== null &&
    typeof lookup.billing.lastAsaasEventAt === "number" &&
    eventTimestamp <= lookup.billing.lastAsaasEventAt
  ) {
    return {
      outcome: "out_of_order",
      event: envelope.event,
      establishmentId: identity.establishmentId,
      generation: identity.generation,
    };
  }

  const transition = nextBillingStatus(lookup.billing.billingStatus, { type: domainEvent });
  if (!transition.ok) {
    return {
      outcome: "invalid_transition",
      event: envelope.event,
      establishmentId: identity.establishmentId,
      generation: identity.generation,
      from: lookup.billing.billingStatus,
    };
  }

  await deps.applyBillingTransition(identity.establishmentId, {
    billingStatus: transition.next,
    lastAsaasEventAt: eventTimestamp ?? deps.now(),
    nextDueDate: extractNextDueDate(envelope.data),
  });

  return {
    outcome: "applied",
    event: envelope.event,
    establishmentId: identity.establishmentId,
    generation: identity.generation,
    from: lookup.billing.billingStatus,
    to: transition.next,
  };
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.code === 6 || e.code === "already-exists") return true;
  return typeof e.message === "string" && e.message.includes("ALREADY_EXISTS");
}

// Fábrica das dependências reais — só chamada pela rota, depois de
// autenticação e parsing já terem passado (mesmo padrão de
// createSandboxHarnessDependencies). Import do Firestore adiado para não
// pagar custo de inicialização em nenhum outro caminho.
export async function createAsaasWebhookProcessingDependencies(): Promise<AsaasWebhookProcessingDependencies> {
  const { db } = await import("@/lib/firebase/admin");
  return {
    reserveEventId: async (eventId) => {
      const ref = db.collection("_processed_asaas_events").doc(eventId);
      try {
        await ref.create({ at: Date.now() });
        return true;
      } catch (err) {
        if (isAlreadyExists(err)) return false;
        throw err;
      }
    },
    getEstablishmentBilling: async (establishmentId) => {
      const snap = await db.collection("establishments").doc(establishmentId).get();
      if (!snap.exists) return { found: false };
      const data = snap.data() as { billing?: EstablishmentBilling };
      return { found: true, billing: data.billing ?? null };
    },
    applyBillingTransition: async (establishmentId, patch) => {
      const ref = db.collection("establishments").doc(establishmentId);
      await ref.update({
        "billing.billingStatus": patch.billingStatus,
        "billing.lastAsaasEventAt": patch.lastAsaasEventAt,
        "billing.updatedAt": Date.now(),
        ...(patch.nextDueDate !== undefined ? { "billing.nextDueDate": patch.nextDueDate } : {}),
      });
    },
    now: Date.now,
  };
}
