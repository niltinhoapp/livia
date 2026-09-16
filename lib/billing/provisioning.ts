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
  return {
    kind: error.kind,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.errors
      ? { codes: error.errors.map((item) => item.code).filter((code): code is string => Boolean(code)) }
      : {}),
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

// Cópia deliberada de subscriptionMatches SEM a condição de nextDueDate —
// nunca extraída/reaproveitada por composição, para que subscriptionMatches
// (usada em provisionAsaasSubscription, replay normal e verificação
// pós-POST) permaneça absolutamente intocada por esta OT (OT-05H-Z). Usada
// só dentro de reconcileConflictedSubscription quando nextDueDate diverge,
// para confirmar que TODOS os outros campos batem estritamente antes de
// sequer considerar avanço temporal.
function subscriptionMatchesExceptNextDueDate(
  subscription: AsaasSubscription,
  intent: BillingProvisioningIntent,
): boolean {
  return (
    subscription.customer === intent.asaasCustomerId &&
    subscription.externalReference === intent.externalReference &&
    subscription.billingType === intent.terms.billingType &&
    toCents(subscription.value) === toCents(intent.terms.value) &&
    subscription.cycle === intent.terms.cycle &&
    (intent.terms.description === undefined ||
      subscription.description === undefined ||
      subscription.description === intent.terms.description)
  );
}

const ISO_DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE_PARTS.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

// Último dia do mês pedido, em UTC puro — "dia 0 do mês seguinte".
function daysInMonth(year: number, month1Based: number): number {
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
}

// Só os 5 cycles mensais têm multiplicador de meses; WEEKLY/BIWEEKLY usam
// passo de dias exato (ver CYCLE_DAYS) — nunca os dois ao mesmo tempo.
const CYCLE_MONTHS: Partial<Record<AsaasCycle, number>> = {
  MONTHLY: 1,
  BIMONTHLY: 2,
  QUARTERLY: 3,
  SEMIANNUALLY: 6,
  YEARLY: 12,
};

const CYCLE_DAYS: Partial<Record<AsaasCycle, number>> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
};

// Teto de segurança por tempo decorrido (não por N fixo) — cobre
// folgadamente qualquer recovery tardio realista (~5 anos) sem permitir
// loop ilimitado, igual para ciclos curtos (muitos N) ou longos (poucos N).
const MAX_ELAPSED_DAYS_FOR_CYCLE_ADVANCE = 5 * 366;

// Determina se `targetIso` corresponde a exatamente N ciclos (N >= 1) à
// frente de `originIso`, segundo `cycle`. Retorna null sempre que isso não
// puder ser determinado com segurança: data malformada, retrocesso,
// diferença que não é múltiplo exato do ciclo, cycle fora dos 7 conhecidos,
// e — para ciclos mensais — quando o dia de origem não existe no mês-alvo
// (ex.: dia 31 caindo num mês de 30 dias). Esse último caso é
// deliberadamente fail-closed: a documentação oficial da Asaas NÃO define
// se ela usaria "clamp" (último dia do mês) ou "rollover" (transbordar pro
// mês seguinte) nesse cenário (auditoria OT-05H-X), e aceitar qualquer uma
// das duas convenções sem essa confirmação seria adivinhar, não validar.
// Para o caso conhecido da gen4 (2026-10-01 → 2026-11-01, dia 1, MONTHLY)
// não há essa ambiguidade: dia 1 existe em todo mês.
function nextDueDateCycleAdvance(
  cycle: AsaasCycle,
  originIso: string,
  targetIso: string,
): number | null {
  const origin = parseIsoDateParts(originIso);
  const target = parseIsoDateParts(targetIso);
  if (!origin || !target) return null;

  const originUtc = Date.UTC(origin.year, origin.month - 1, origin.day);
  const targetUtc = Date.UTC(target.year, target.month - 1, target.day);
  if (targetUtc <= originUtc) return null; // nunca aceita retrocesso

  const daysStep = CYCLE_DAYS[cycle];
  if (daysStep !== undefined) {
    const diffDays = Math.round((targetUtc - originUtc) / 86_400_000);
    if (diffDays % daysStep !== 0) return null;
    const n = diffDays / daysStep;
    const maxN = Math.floor(MAX_ELAPSED_DAYS_FOR_CYCLE_ADVANCE / daysStep);
    return n >= 1 && n <= maxN ? n : null;
  }

  const monthsStep = CYCLE_MONTHS[cycle];
  if (monthsStep !== undefined) {
    const maxN = Math.max(1, Math.floor(MAX_ELAPSED_DAYS_FOR_CYCLE_ADVANCE / 28 / monthsStep));
    for (let n = 1; n <= maxN; n += 1) {
      const monthIndex = origin.month - 1 + n * monthsStep;
      const candidateYear = origin.year + Math.floor(monthIndex / 12);
      const candidateMonth = (monthIndex % 12) + 1;
      if (origin.day > daysInMonth(candidateYear, candidateMonth)) continue; // ambíguo, pula sem adivinhar
      const candidateUtc = Date.UTC(candidateYear, candidateMonth - 1, origin.day);
      if (candidateUtc === targetUtc) return n;
    }
    return null;
  }

  return null; // cycle fora dos 7 conhecidos — defesa em profundidade
}

// Allowlist mínima e deliberada (OT-05H-Z): dos 14 status oficiais de
// payment confirmados na auditoria OT-05H-X, só PENDING é aceito hoje como
// prova de que a cobrança original do ciclo pedido pela intent foi
// realmente emitida pela Asaas. É o único status observado empiricamente
// na gen4 (OT-05H-U) e o único usado neste repositório antes desta OT.
// Ampliar esta lista (ex.: RECEIVED, CONFIRMED) exige decisão própria,
// confirmando que o novo valor realmente significa "cobrança emitida e
// não estornada/cancelada" — nunca suposição. Não modifica o parser
// genérico isAsaasPayment (PR #67): a allowlist vive só aqui, no guard
// financeiro que precisa dela.
const RECOVERY_ELIGIBLE_PAYMENT_STATUSES = new Set<string>(["PENDING"]);

type OriginalPaymentEvidence =
  | { ok: true; payment: AsaasPayment }
  | { ok: false; reason: "original_payment_not_found" | "original_payment_ambiguous" | "original_payment_not_eligible" };

// Exige exatamente 1 payment cujo dueDate seja igual, caractere-a-caractere,
// ao nextDueDate ORIGINAL da intent (nunca de um ciclo intermediário) — e
// só então avalia elegibilidade (value/deleted/status/customer/subscription)
// nesse único candidato. 0 ou >1 payments com o dueDate correto nunca chega
// a avaliar elegibilidade — a ambiguidade em qual cobrança é "a original"
// já é suficiente para falhar fechado.
function findOriginalPaymentEvidence(
  payments: AsaasPayment[],
  subscriptionId: string,
  intent: BillingProvisioningIntent,
): OriginalPaymentEvidence {
  const byDueDate = payments.filter((payment) => payment.dueDate === intent.terms.nextDueDate);
  if (byDueDate.length === 0) return { ok: false, reason: "original_payment_not_found" };
  if (byDueDate.length > 1) return { ok: false, reason: "original_payment_ambiguous" };

  const candidate = byDueDate[0]!;
  const eligible =
    candidate.value !== undefined &&
    Number.isFinite(candidate.value) &&
    toCents(candidate.value) === toCents(intent.terms.value) &&
    candidate.deleted === false &&
    typeof candidate.status === "string" &&
    RECOVERY_ELIGIBLE_PAYMENT_STATUSES.has(candidate.status) &&
    (candidate.customer === undefined || candidate.customer === intent.asaasCustomerId) &&
    (candidate.subscription === undefined || candidate.subscription === subscriptionId);

  return eligible ? { ok: true, payment: candidate } : { ok: false, reason: "original_payment_not_eligible" };
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

  const markCreatedConflict = (code: string, error?: SanitizedProvisioningError) =>
    transitionWithLease(identity, leaseId, (current) => {
      if (current.attemptId !== attemptId || current.phase !== "creating") return null;
      return {
        phase: "conflict",
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: error ?? { kind: "conflict", code },
        conflictSubscriptionIds: [created.data.id],
      };
    });

  if (created.data.nextDueDate === creating.terms.nextDueDate) {
    // Caminho atual, inalterado: subscriptionMatches decide tudo.
    if (!subscriptionMatches(created.data, creating)) {
      const conflicted = await markCreatedConflict("created_subscription_mismatch");
      return { ok: false, phase: "conflict", reason: "created_subscription_mismatch", intent: conflicted ?? undefined };
    }
  } else {
    // nextDueDate divergiu já na resposta do POST (OT-05H-AH / RCA
    // OT-05H-AG, reproduzido na gen5). A Asaas documenta
    // subscription.nextDueDate como "vencimento do próximo pagamento a
    // ser gerado" — semanticamente diferente de request.nextDueDate
    // ("vencimento da primeira cobrança"). Não afirmamos em que instante
    // interno a Asaas avança esse ponteiro; só reagimos ao fato
    // observável. Nunca usa subscriptionMatches puro aqui — ele
    // rejeitaria pela igualdade estrita antes de qualquer análise.
    // Primeiro confirma que TODOS os outros campos batem estritamente.
    if (!subscriptionMatchesExceptNextDueDate(created.data, creating)) {
      const conflicted = await markCreatedConflict("created_subscription_mismatch");
      return { ok: false, phase: "conflict", reason: "created_subscription_mismatch", intent: conflicted ?? undefined };
    }

    // Diferente do recovery: aqui só existe UM ciclo possível — o
    // primeiro, da própria criação. Não há "N ciclos decorridos" a
    // calcular (nextDueDateCycleAdvance não se aplica). A evidência
    // autoritativa do vencimento pedido é a cobrança já observável nesta
    // resposta (comprovado pela gen5) — não o ponteiro nextDueDate da
    // subscription. Não afirmamos em que instante interno a Asaas gera
    // essa cobrança.
    const paymentsLookup = await dependencies.asaas.listSubscriptionPayments(created.data.id);
    if (!paymentsLookup.ok) {
      const conflicted = await markCreatedConflict("", sanitizedError(paymentsLookup.error));
      return { ok: false, phase: "conflict", reason: "lookup_failed", intent: conflicted ?? undefined };
    }

    const evidence = findOriginalPaymentEvidence(paymentsLookup.data, created.data.id, creating);
    if (!evidence.ok) {
      const conflicted = await markCreatedConflict(evidence.reason);
      return { ok: false, phase: "conflict", reason: evidence.reason, intent: conflicted ?? undefined };
    }
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

// Sem createSubscription por design: recovery nunca cria, só valida
// existente. `Pick<AsaasClient, ...>` garante isso estruturalmente — o
// próprio AsaasClient não declara updateSubscription/deleteSubscription/
// createPayment nem nenhum outro método de escrita além de
// createSubscription (ver asaas.ts), que fica deliberadamente fora deste
// Pick. listSubscriptionPayments (OT-05H-Z) é leitura pura, usada só para
// coletar evidência de recovery temporal de nextDueDate.
type ConflictRecoveryClient = Pick<
  AsaasClient,
  "getSubscription" | "findSubscriptionsForReconciliation" | "listSubscriptionPayments"
>;

export interface ConflictRecoveryDependencies {
  asaas: ConflictRecoveryClient;
  now: () => number;
  newId: () => string;
  leaseDurationMs?: number;
}

async function acquireConflictRecoveryLease(
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
    if (
      current.phase !== "conflict" ||
      current.externalSubscriptionId !== null ||
      current.conflictSubscriptionIds?.length !== 1
    ) {
      return { acquired: false, intent: current };
    }
    if (current.leaseId && current.leaseExpiresAt !== null && current.leaseExpiresAt > now) {
      return { acquired: false, intent: current };
    }
    const leased: BillingProvisioningIntent = {
      ...current,
      leaseId,
      leaseOwner,
      leaseExpiresAt: now + leaseDurationMs,
      updatedAt: now,
    };
    tx.update(ref, { leaseId, leaseOwner, leaseExpiresAt: leased.leaseExpiresAt, updatedAt: now });
    return { acquired: true, intent: leased };
  });
}

export async function reconcileConflictedSubscription(
  establishmentId: string,
  generation: number,
  leaseOwner: string,
  dependencies: ConflictRecoveryDependencies,
): Promise<ProvisioningResult> {
  const intent = await getBillingProvisioningIntent(establishmentId, generation);
  if (!intent) return { ok: false, phase: "conflict", reason: "intent_not_found" };

  if (
    intent.phase !== "conflict" ||
    intent.externalSubscriptionId !== null ||
    intent.conflictSubscriptionIds?.length !== 1
  ) {
    if (intent.phase === "succeeded") {
      return { ok: true, phase: "succeeded", outcome: "verified", intent };
    }
    return { ok: false, phase: "conflict", reason: "not_recoverable", intent };
  }

  const identity = identityOf(intent);
  const leaseId = dependencies.newId();
  const now = dependencies.now();

  const acquired = await acquireConflictRecoveryLease(
    identity,
    leaseId,
    leaseOwner,
    now,
    dependencies.leaseDurationMs ?? DEFAULT_LEASE_MS,
  );
  if (!acquired) return { ok: false, phase: "conflict", reason: "intent_changed" };
  if (!acquired.acquired) {
    if (acquired.intent.phase === "succeeded") {
      return { ok: true, phase: "succeeded", outcome: "verified", intent: acquired.intent };
    }
    return { ok: false, phase: "conflict", reason: "busy_or_not_recoverable", intent: acquired.intent };
  }

  // Estratégia B: busca pelo externalReference canônico
  const lookup = await dependencies.asaas.findSubscriptionsForReconciliation({
    customer: intent.asaasCustomerId,
    externalReference: intent.externalReference,
    includeDeleted: true,
  });

  if (!lookup.ok) {
    await transitionWithLease(identity, leaseId, (current) => {
      if (current.phase !== "conflict") return null;
      return {
        leaseId: null, leaseOwner: null, leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: sanitizedError(lookup.error),
      };
    });
    return { ok: false, phase: "conflict", reason: "lookup_failed" };
  }

  if (lookup.data.length === 0) {
    await transitionWithLease(identity, leaseId, (current) => {
      if (current.phase !== "conflict") return null;
      return {
        leaseId: null, leaseOwner: null, leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: { kind: "conflict", code: "no_subscription_found" },
      };
    });
    return { ok: false, phase: "conflict", reason: "no_subscription_found" };
  }

  if (lookup.data.length > 1) {
    await transitionWithLease(identity, leaseId, (current) => {
      if (current.phase !== "conflict") return null;
      return {
        leaseId: null, leaseOwner: null, leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: { kind: "conflict", code: "multiple_subscriptions_on_recovery" },
        conflictSubscriptionIds: lookup.data.map((s) => s.id),
      };
    });
    return { ok: false, phase: "conflict", reason: "multiple_subscriptions" };
  }

  const found = lookup.data[0]!;

  // Cross-check A: ID deve coincidir com conflictSubscriptionIds[0]
  const storedConflictId = acquired.intent.conflictSubscriptionIds![0]!;
  if (found.id !== storedConflictId) {
    await transitionWithLease(identity, leaseId, (current) => {
      if (current.phase !== "conflict") return null;
      return {
        leaseId: null, leaseOwner: null, leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: { kind: "conflict", code: "conflict_id_mismatch" },
      };
    });
    return { ok: false, phase: "conflict", reason: "conflict_id_mismatch" };
  }

  // Guard de status: só promove subscription ACTIVE
  if (found.status !== "ACTIVE") {
    await transitionWithLease(identity, leaseId, (current) => {
      if (current.phase !== "conflict") return null;
      return {
        leaseId: null, leaseOwner: null, leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: { kind: "conflict", code: "subscription_not_active" },
      };
    });
    return { ok: false, phase: "conflict", reason: "subscription_not_active" };
  }

  const releaseWithConflict = (code: string) =>
    transitionWithLease(identity, leaseId, (current) => {
      if (current.phase !== "conflict") return null;
      return {
        leaseId: null, leaseOwner: null, leaseExpiresAt: null,
        updatedAt: dependencies.now(),
        lastError: { kind: "conflict", code },
      };
    });

  if (found.nextDueDate === acquired.intent.terms.nextDueDate) {
    // Caminho rápido: nextDueDate bate exatamente — subscriptionMatches
    // (intocada) decide tudo, sem nenhuma chamada extra a
    // listSubscriptionPayments.
    if (!subscriptionMatches(found, acquired.intent)) {
      await releaseWithConflict("subscription_mismatch_on_recovery");
      return { ok: false, phase: "conflict", reason: "subscription_mismatch" };
    }
  } else {
    // nextDueDate divergiu (OT-05H-Z): nunca usa subscriptionMatches puro
    // aqui — ele rejeitaria pela igualdade estrita de nextDueDate antes de
    // qualquer análise temporal. Primeiro confirma que TODOS os outros
    // campos batem estritamente (mesma força de subscriptionMatches, exceto
    // nextDueDate).
    if (!subscriptionMatchesExceptNextDueDate(found, acquired.intent)) {
      await releaseWithConflict("subscription_mismatch_on_recovery");
      return { ok: false, phase: "conflict", reason: "subscription_mismatch" };
    }

    const advance = nextDueDateCycleAdvance(
      acquired.intent.terms.cycle,
      acquired.intent.terms.nextDueDate,
      found.nextDueDate,
    );
    if (advance === null) {
      await releaseWithConflict("next_due_date_not_valid_cycle_advance");
      return { ok: false, phase: "conflict", reason: "next_due_date_not_valid_cycle_advance" };
    }

    const paymentsLookup = await dependencies.asaas.listSubscriptionPayments(found.id);
    if (!paymentsLookup.ok) {
      await transitionWithLease(identity, leaseId, (current) => {
        if (current.phase !== "conflict") return null;
        return {
          leaseId: null, leaseOwner: null, leaseExpiresAt: null,
          updatedAt: dependencies.now(),
          lastError: sanitizedError(paymentsLookup.error),
        };
      });
      return { ok: false, phase: "conflict", reason: "lookup_failed" };
    }

    const evidence = findOriginalPaymentEvidence(paymentsLookup.data, found.id, acquired.intent);
    if (!evidence.ok) {
      await releaseWithConflict(evidence.reason);
      return { ok: false, phase: "conflict", reason: evidence.reason };
    }
  }

  // Todos os guards passaram: promove para succeeded
  const succeeded = await transitionWithLease(identity, leaseId, (current) => {
    if (current.phase !== "conflict" || current.externalSubscriptionId !== null) return null;
    return {
      phase: "succeeded",
      externalSubscriptionId: found.id,
      leaseId: null, leaseOwner: null, leaseExpiresAt: null,
      updatedAt: dependencies.now(),
      lastError: null,
      // conflictSubscriptionIds mantido como audit trail
    };
  });

  if (!succeeded) return { ok: false, phase: "conflict", reason: "intent_changed" };
  return { ok: true, phase: "succeeded", outcome: "reconciled", intent: succeeded };
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
