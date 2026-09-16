// Workflow dormente para o produto de provisionamento/reconciliação Asaas.
// O único acionamento HTTP atual é o harness administrativo Preview/Sandbox;
// nenhuma rota de produto, webhook ou cron o utiliza. Firestore coordena a
// intenção local; chamadas Asaas acontecem SEMPRE fora de transactions.
import { createHash } from "node:crypto";
import { db } from "@/lib/firebase/admin";
import type {
  AsaasBillingType,
  AsaasClient,
  AsaasCycle,
  AsaasError,
  AsaasPayment,
  AsaasSubscription,
} from "./asaas";

export type BillingProvisioningPhase =
  | "reserved"
  | "creating"
  | "reconciling"
  | "succeeded"
  | "conflict"
  | "failed_terminal";

export interface SubscriptionTerms {
  billingType: AsaasBillingType;
  value: number;
  cycle: AsaasCycle;
  nextDueDate: string;
  description?: string;
}

export interface SanitizedProvisioningError {
  kind: AsaasError["kind"] | "conflict";
  status?: number;
  codes?: string[];
  descriptions?: string[];
  code?: string;
}

export interface BillingProvisioningIntent {
  operationId: string;
  establishmentId: string;
  subscriptionGeneration: number;
  externalReference: string;
  asaasCustomerId: string;
  fingerprint: string;
  terms: SubscriptionTerms;
  phase: BillingProvisioningPhase;
  attemptId: string | null;
  leaseId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  externalSubscriptionId: string | null;
  createdAt: number;
  updatedAt: number;
  lastError: SanitizedProvisioningError | null;
  conflictSubscriptionIds?: string[];
  conflictPaymentCounts?: Record<string, number | null>;
}

export interface ProvisionSubscriptionInput extends SubscriptionTerms {
  establishmentId: string;
  subscriptionGeneration: number;
  asaasCustomerId: string;
  leaseOwner: string;
  leaseDurationMs?: number;
}

type ReconciliationClient = Pick<
  AsaasClient,
  | "createSubscription"
  | "getSubscription"
  | "findSubscriptionsForReconciliation"
  | "listSubscriptionPayments"
>;

export interface ProvisioningDependencies {
  asaas: ReconciliationClient;
  now: () => number;
  newId: () => string;
  // Ponto de injeção para testar crash exatamente após a resposta do POST e
  // antes da persistência. O workflow dormente não fornece hook por padrão.
  afterCreateSubscription?: (subscription: AsaasSubscription) => Promise<void> | void;
}

export type ProvisioningResult =
  | {
      ok: true;
      phase: "succeeded";
      outcome: "created" | "reconciled" | "verified";
      intent: BillingProvisioningIntent;
    }
  | {
      ok: true;
      phase: "reserved" | "creating" | "reconciling";
      outcome: "busy" | "awaiting_reconciliation" | "lookup_failed";
      intent: BillingProvisioningIntent;
    }
  | {
      ok: false;
      phase: "conflict" | "failed_terminal";
      reason: string;
      intent?: BillingProvisioningIntent;
    };

interface IntentIdentity {
  operationId: string;
  establishmentId: string;
  subscriptionGeneration: number;
  externalReference: string;
  asaasCustomerId: string;
  fingerprint: string;
}

const DEFAULT_LEASE_MS = 30_000;

export function logicalSubscriptionExternalReference(
  establishmentId: string,
  generation: number,
): string {
  validateLogicalIdentity(establishmentId, generation);
  return `livia:subscription:${establishmentId}:${generation}`;
}

export function logicalSubscriptionOperationId(
  establishmentId: string,
  generation: number,
): string {
  validateLogicalIdentity(establishmentId, generation);
  return `${establishmentId}:${generation}`;
}

export function subscriptionFingerprint(terms: SubscriptionTerms): string {
  validateTerms(terms);
  const canonical = JSON.stringify([
    "subscription-v1",
    terms.billingType,
    toCents(terms.value),
    terms.cycle,
    terms.nextDueDate,
    terms.description ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function validateLogicalIdentity(establishmentId: string, generation: number): void {
  if (!establishmentId || establishmentId.includes("/")) {
    throw new Error("Billing provisioning: establishmentId inválido.");
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Billing provisioning: generation deve ser inteiro positivo.");
  }
}

function validateTerms(terms: SubscriptionTerms): void {
  if (!Number.isFinite(terms.value) || terms.value <= 0) {
    throw new Error("Billing provisioning: value deve ser positivo e finito.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(terms.nextDueDate)) {
    throw new Error("Billing provisioning: nextDueDate inválido.");
  }
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function intentRef(establishmentId: string, generation: number) {
  return db
    .collection("establishments")
    .doc(establishmentId)
    .collection("billingProvisioning")
    .doc(String(generation));
}

function identityOf(intent: BillingProvisioningIntent): IntentIdentity {
  return {
    operationId: intent.operationId,
    establishmentId: intent.establishmentId,
    subscriptionGeneration: intent.subscriptionGeneration,
    externalReference: intent.externalReference,
    asaasCustomerId: intent.asaasCustomerId,
    fingerprint: intent.fingerprint,
  };
}

function identityMatches(intent: BillingProvisioningIntent, expected: IntentIdentity): boolean {
  return (
    intent.operationId === expected.operationId &&
    intent.establishmentId === expected.establishmentId &&
    intent.subscriptionGeneration === expected.subscriptionGeneration &&
    intent.externalReference === expected.externalReference &&
    intent.asaasCustomerId === expected.asaasCustomerId &&
    intent.fingerprint === expected.fingerprint
  );
}

function seedIntent(input: ProvisionSubscriptionInput, now: number): BillingProvisioningIntent {
  const externalReference = logicalSubscriptionExternalReference(
    input.establishmentId,
    input.subscriptionGeneration,
  );
  const terms: SubscriptionTerms = {
    billingType: input.billingType,
    value: input.value,
    cycle: input.cycle,
    nextDueDate: input.nextDueDate,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  return {
    operationId: logicalSubscriptionOperationId(input.establishmentId, input.subscriptionGeneration),
    establishmentId: input.establishmentId,
    subscriptionGeneration: input.subscriptionGeneration,
    externalReference,
    asaasCustomerId: input.asaasCustomerId,
    fingerprint: subscriptionFingerprint(terms),
    terms,
    phase: "reserved",
    attemptId: null,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    externalSubscriptionId: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
}

async function reserveIntent(seed: BillingProvisioningIntent): Promise<
  | { ok: true; intent: BillingProvisioningIntent }
  | { ok: false; reason: "identity_conflict"; intent: BillingProvisioningIntent }
> {
  const ref = intentRef(seed.establishmentId, seed.subscriptionGeneration);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const current = snap.data() as BillingProvisioningIntent;
      return identityMatches(current, identityOf(seed))
        ? { ok: true as const, intent: current }
        : { ok: false as const, reason: "identity_conflict" as const, intent: current };
    }
    tx.create(ref, seed);
    return { ok: true as const, intent: seed };
  });
}

async function acquireLease(
  identity: IntentIdentity,
  leaseId: string,
  leaseOwner: string,
  now: number,
  leaseDurationMs: number,
): Promise<{ acquired: boolean; intent: BillingProvisioningIntent } | null> {
  const ref = intentRef(identity.establishmentId, identity.subscriptionGeneration);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as BillingProvisioningIntent;
    if (!identityMatches(current, identity)) return null;
    if (current.externalSubscriptionId || current.phase === "conflict" || current.phase === "failed_terminal") {
      return { acquired: false, intent: current };
    }
    if (current.leaseId && current.leaseExpiresAt !== null && current.leaseExpiresAt > now) {
      return { acquired: false, intent: current };
    }
    const phase = current.phase === "creating" ? "reconciling" : current.phase;
    const leased: BillingProvisioningIntent = {
      ...current,
      phase,
      leaseId,
      leaseOwner,
      leaseExpiresAt: now + leaseDurationMs,
      updatedAt: now,
    };
    tx.update(ref, {
      phase,
      leaseId,
      leaseOwner,
      leaseExpiresAt: leased.leaseExpiresAt,
      updatedAt: now,
    });
    return { acquired: true, intent: leased };
  });
}

async function transitionWithLease(
  identity: IntentIdentity,
  leaseId: string,
  update: (current: BillingProvisioningIntent) => Partial<BillingProvisioningIntent> | null,
): Promise<BillingProvisioningIntent | null> {
  const ref = intentRef(identity.establishmentId, identity.subscriptionGeneration);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as BillingProvisioningIntent;
    if (!identityMatches(current, identity) || current.leaseId !== leaseId) return null;
    const patch = update(current);
    if (!patch) return null;
    tx.update(ref, patch);
    return { ...current, ...patch };
  });
}

async function markKnownSubscriptionConflict(
  identity: IntentIdentity,
  expectedSubscriptionId: string,
  now: number,
  code: string,
): Promise<BillingProvisioningIntent | null> {
  const ref = intentRef(identity.establishmentId, identity.subscriptionGeneration);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as BillingProvisioningIntent;
    if (
      !identityMatches(current, identity) ||
      current.externalSubscriptionId !== expectedSubscriptionId
    ) {
      return null;
    }
    const patch: Partial<BillingProvisioningIntent> = {
      phase: "conflict",
      updatedAt: now,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: { kind: "conflict", code },
      conflictSubscriptionIds: [expectedSubscriptionId],
    };
    tx.update(ref, patch);
    return { ...current, ...patch };
  });
}

async function markKnownSubscriptionLookupFailure(
  identity: IntentIdentity,
  expectedSubscriptionId: string,
  now: number,
  error: AsaasError,
): Promise<BillingProvisioningIntent | null> {
  const ref = intentRef(identity.establishmentId, identity.subscriptionGeneration);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as BillingProvisioningIntent;
    if (
      !identityMatches(current, identity) ||
      current.externalSubscriptionId !== expectedSubscriptionId
    ) {
      return null;
    }
    const patch: Partial<BillingProvisioningIntent> = {
      phase: "reconciling",
      updatedAt: now,
      lastError: sanitizedError(error),
    };
    tx.update(ref, patch);
    return { ...current, ...patch };
  });
}

function sanitizedError(error: AsaasError): SanitizedProvisioningError {
  const descriptions = error.errors
    ?.map((item) => item.description)
    .filter((d): d is string => Boolean(d));
  return {
    kind: error.kind,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.errors
      ? { codes: error.errors.map((item) => item.code).filter((code): code is string => Boolean(code)) }
      : {}),
    ...(descriptions?.length ? { descriptions } : {}),
  };
}

function isConclusiveHttpRejection(error: AsaasError): boolean {
  return error.kind === "http" && [400, 401, 403, 404, 422].includes(error.status ?? 0);
}

function subscriptionMatches(
  subscription: AsaasSubscription,
  intent: BillingProvisioningIntent,
): boolean {
  return (
    subscription.customer === intent.asaasCustomerId &&
    subscription.externalReference === intent.externalReference &&
    subscription.billingType === intent.terms.billingType &&
    toCents(subscription.value) === toCents(intent.terms.value) &&
    subscription.cycle === intent.terms.cycle &&
    subscription.nextDueDate === intent.terms.nextDueDate &&
    (intent.terms.description === undefined ||
      subscription.description === undefined ||
      subscription.description === intent.terms.description)
  );
}

async function inspectDuplicatePayments(
  asaas: ReconciliationClient,
  subscriptions: AsaasSubscription[],
): Promise<Record<string, number | null>> {
  const entries = await Promise.all(
    subscriptions.map(async (subscription) => {
      const payments = await asaas.listSubscriptionPayments(subscription.id);
      return [subscription.id, payments.ok ? payments.data.length : null] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function provisionAsaasSubscription(
  input: ProvisionSubscriptionInput,
  dependencies: ProvisioningDependencies,
): Promise<ProvisioningResult> {
  if (!input.asaasCustomerId || !input.leaseOwner) {
    throw new Error("Billing provisioning: customer e leaseOwner são obrigatórios.");
  }
  if (
    input.leaseDurationMs !== undefined &&
    (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0)
  ) {
    throw new Error("Billing provisioning: leaseDurationMs deve ser positivo.");
  }
  const initialNow = dependencies.now();
  const seed = seedIntent(input, initialNow);
  const identity = identityOf(seed);
  const reservation = await reserveIntent(seed);
  if (!reservation.ok) {
    return { ok: false, phase: "conflict", reason: reservation.reason, intent: reservation.intent };
  }

  // ID conhecido é sempre a evidência mais forte. A consulta é externa, mas
  // read-only e acontece fora da transaction que carregou a intent.
  if (reservation.intent.externalSubscriptionId) {
    const knownId = reservation.intent.externalSubscriptionId;
    const found = await dependencies.asaas.getSubscription(knownId);
    if (!found.ok) {
      // Somente 404 prova que o ID persistido não é recuperável nesta conta.
      // 401/403/5xx são falhas de configuração/infra e permanecem reconciliáveis.
      if (found.error.kind === "http" && found.error.status === 404) {
        const conflicted = await markKnownSubscriptionConflict(
          identity,
          knownId,
          dependencies.now(),
          "known_subscription_unavailable",
        );
        return {
          ok: false,
          phase: "conflict",
          reason: "known_subscription_unavailable",
          intent: conflicted ?? undefined,
        };
      }
      const reconciling = await markKnownSubscriptionLookupFailure(
        identity,
        knownId,
        dependencies.now(),
        found.error,
      );
      if (!reconciling) return { ok: false, phase: "conflict", reason: "intent_changed" };
      return {
        ok: true,
        phase: "reconciling",
        outcome: "lookup_failed",
        intent: reconciling,
      };
    }
    if (!subscriptionMatches(found.data, reservation.intent)) {
      const conflicted = await markKnownSubscriptionConflict(
        identity,
        knownId,
        dependencies.now(),
        "known_subscription_mismatch",
      );
      return { ok: false, phase: "conflict", reason: "known_subscription_mismatch", intent: conflicted ?? undefined };
    }
    return { ok: true, phase: "succeeded", outcome: "verified", intent: reservation.intent };
  }

  const leaseId = dependencies.newId();
  const acquired = await acquireLease(
    identity,
    leaseId,
    input.leaseOwner,
    dependencies.now(),
    input.leaseDurationMs ?? DEFAULT_LEASE_MS,
  );
  if (!acquired) return { ok: false, phase: "conflict", reason: "intent_changed" };
  if (!acquired.acquired) {
    if (acquired.intent.phase === "conflict" || acquired.intent.phase === "failed_terminal") {
      return {
        ok: false,
        phase: acquired.intent.phase,
        reason: acquired.intent.phase,
        intent: acquired.intent,
      };
    }
    return { ok: true, phase: acquired.intent.phase as "reserved" | "creating" | "reconciling", outcome: "busy", intent: acquired.intent };
  }

  const lookup = await dependencies.asaas.findSubscriptionsForReconciliation({
    customer: seed.asaasCustomerId,
    externalReference: seed.externalReference,
    includeDeleted: true,
  });
  if (!lookup.ok) {
    const released = await transitionWithLease(identity, leaseId, (current) => ({
      phase: current.phase === "reserved" ? "reserved" : "reconciling",
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: dependencies.now(),
      lastError: sanitizedError(lookup.error),
    }));
    if (!released) return { ok: false, phase: "conflict", reason: "intent_changed" };
    return { ok: true, phase: released.phase as "reserved" | "reconciling", outcome: "lookup_failed", intent: released };
  }

  if (lookup.data.length > 1) {
    const paymentCounts = await inspectDuplicatePayments(dependencies.asaas, lookup.data);
    const conflicted = await transitionWithLease(identity, leaseId, () => ({
      phase: "conflict",
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: dependencies.now(),
      lastError: { kind: "conflict", code: "multiple_subscriptions" },
      conflictSubscriptionIds: lookup.data.map((subscription) => subscription.id),
      conflictPaymentCounts: paymentCounts,
    }));
    return { ok: false, phase: "conflict", reason: "multiple_subscriptions", intent: conflicted ?? undefined };
  }

  if (lookup.data.length === 1) {
    const existing = lookup.data[0]!;
    if (!subscriptionMatches(existing, acquired.intent)) {
      const conflicted = await transitionWithLease(identity, leaseId, () => ({
        phase: "conflict",
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: { kind: "conflict", code: "subscription_mismatch" },
        conflictSubscriptionIds: [existing.id],
      }));
      return { ok: false, phase: "conflict", reason: "subscription_mismatch", intent: conflicted ?? undefined };
    }
    const succeeded = await transitionWithLease(identity, leaseId, () => ({
      phase: "succeeded",
      externalSubscriptionId: existing.id,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: dependencies.now(),
      lastError: null,
    }));
    if (!succeeded) return { ok: false, phase: "conflict", reason: "intent_changed" };
    return { ok: true, phase: "succeeded", outcome: "reconciled", intent: succeeded };
  }

  // Uma tentativa anterior pode ter chegado à Asaas mesmo sem deixar
  // resposta local. Zero resultados NÃO reabre o direito de fazer POST.
  if (acquired.intent.phase !== "reserved") {
    const reconciling = await transitionWithLease(identity, leaseId, () => ({
      phase: "reconciling",
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: dependencies.now(),
    }));
    if (!reconciling) return { ok: false, phase: "conflict", reason: "intent_changed" };
    return { ok: true, phase: "reconciling", outcome: "awaiting_reconciliation", intent: reconciling };
  }

  const attemptId = dependencies.newId();
  const creating = await transitionWithLease(identity, leaseId, (current) => {
    if (current.phase !== "reserved" || current.attemptId !== null) return null;
    return { phase: "creating", attemptId, updatedAt: dependencies.now() };
  });
  if (!creating) return { ok: false, phase: "conflict", reason: "intent_changed" };

  // Único POST do workflow, deliberadamente fora de qualquer transaction.
  const created = await dependencies.asaas.createSubscription({
    customer: seed.asaasCustomerId,
    billingType: seed.terms.billingType,
    value: seed.terms.value,
    cycle: seed.terms.cycle,
    nextDueDate: seed.terms.nextDueDate,
    ...(seed.terms.description !== undefined ? { description: seed.terms.description } : {}),
    externalReference: seed.externalReference,
  });

  if (!created.ok) {
    const terminal = isConclusiveHttpRejection(created.error);
    const failed = await transitionWithLease(identity, leaseId, (current) => {
      if (current.attemptId !== attemptId || current.phase !== "creating") return null;
      return {
        phase: terminal ? "failed_terminal" : "reconciling",
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: sanitizedError(created.error),
      };
    });
    if (!failed) return { ok: false, phase: "conflict", reason: "intent_changed" };
    return terminal
      ? { ok: false, phase: "failed_terminal", reason: "asaas_rejected", intent: failed }
      : { ok: true, phase: "reconciling", outcome: "awaiting_reconciliation", intent: failed };
  }

  await dependencies.afterCreateSubscription?.(created.data);

  if (!subscriptionMatches(created.data, creating)) {
    const conflicted = await transitionWithLease(identity, leaseId, (current) => {
      if (current.attemptId !== attemptId || current.phase !== "creating") return null;
      return {
        phase: "conflict",
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: { kind: "conflict", code: "created_subscription_mismatch" },
        conflictSubscriptionIds: [created.data.id],
      };
    });
    return { ok: false, phase: "conflict", reason: "created_subscription_mismatch", intent: conflicted ?? undefined };
  }

  const succeeded = await transitionWithLease(identity, leaseId, (current) => {
    if (current.attemptId !== attemptId || current.phase !== "creating") return null;
    return {
      phase: "succeeded",
      externalSubscriptionId: created.data.id,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: dependencies.now(),
      lastError: null,
    };
  });
  if (!succeeded) return { ok: false, phase: "conflict", reason: "intent_changed" };
  return { ok: true, phase: "succeeded", outcome: "created", intent: succeeded };
}

// Exportado apenas para testes/diagnóstico da fundação; não ativa o workflow.
export async function getBillingProvisioningIntent(
  establishmentId: string,
  generation: number,
): Promise<BillingProvisioningIntent | null> {
  const snap = await intentRef(establishmentId, generation).get();
  return snap.exists ? (snap.data() as BillingProvisioningIntent) : null;
}

export type { AsaasPayment };
