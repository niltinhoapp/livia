// Intent durável do customer usado exclusivamente pelo harness Asaas Sandbox.
// O CPF/CNPJ de teste nunca é persistido: somente um fingerprint da intenção.
// Toda chamada Asaas acontece fora das transactions Firestore.
import { createHash } from "node:crypto";
import { db } from "@/lib/firebase/admin";
import type { AsaasClient, AsaasCustomer, AsaasError } from "./asaas";

export type SandboxCustomerPhase =
  | "reserved"
  | "creating"
  | "reconciling"
  | "succeeded"
  | "conflict"
  | "failed_terminal";

export interface SandboxCustomerIntent {
  testRunId: string;
  externalReference: string;
  fingerprint: string;
  phase: SandboxCustomerPhase;
  attemptId: string | null;
  externalCustomerId: string | null;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt: number | null;
  lastError: SanitizedCustomerError | null;
}

export interface SanitizedCustomerError {
  kind: AsaasError["kind"] | "conflict";
  status?: number;
  codes?: string[];
  code?: string;
}

export interface ProvisionSandboxCustomerInput {
  testRunId: string;
  externalReference: string;
  name: string;
  cpfCnpj: string;
}

type CustomerClient = Pick<AsaasClient, "findCustomersByExternalReference" | "createCustomer">;

export interface SandboxCustomerDependencies {
  asaas: CustomerClient;
  now: () => number;
  newId: () => string;
}

export type SandboxCustomerResult =
  | {
      ok: true;
      phase: "succeeded";
      outcome: "created" | "reconciled" | "verified" | "verification_failed";
      intent: SandboxCustomerIntent;
      verificationError?: SanitizedCustomerError;
    }
  | {
      ok: true;
      phase: "reserved" | "creating" | "reconciling";
      outcome: "busy" | "awaiting_reconciliation" | "lookup_failed";
      intent: SandboxCustomerIntent;
    }
  | {
      ok: false;
      phase: "conflict" | "failed_terminal";
      reason: string;
      intent?: SandboxCustomerIntent;
    };

const CUSTOMER_ID = /^[A-Za-z0-9_-]{3,128}$/;
const SYSTEM_DOC = "asaas-sandbox-harness-v1";

export function sandboxCustomerFingerprint(input: ProvisionSandboxCustomerInput): string {
  const canonical = JSON.stringify([
    "asaas-sandbox-customer-v1",
    input.testRunId,
    input.externalReference,
    input.name,
    input.cpfCnpj,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function intentRef(testRunId: string) {
  if (!testRunId || testRunId.includes("/")) {
    throw new Error("Asaas sandbox customer: testRunId inválido.");
  }
  return db
    .collection("_system")
    .doc(SYSTEM_DOC)
    .collection("customerIntents")
    .doc(testRunId);
}

function seedIntent(input: ProvisionSandboxCustomerInput, now: number): SandboxCustomerIntent {
  return {
    testRunId: input.testRunId,
    externalReference: input.externalReference,
    fingerprint: sandboxCustomerFingerprint(input),
    phase: "reserved",
    attemptId: null,
    externalCustomerId: null,
    createdAt: now,
    updatedAt: now,
    lastAttemptAt: null,
    lastError: null,
  };
}

function identityMatches(current: SandboxCustomerIntent, expected: SandboxCustomerIntent): boolean {
  return (
    current.testRunId === expected.testRunId &&
    current.externalReference === expected.externalReference &&
    current.fingerprint === expected.fingerprint
  );
}

async function reserveIntent(seed: SandboxCustomerIntent): Promise<
  | { ok: true; intent: SandboxCustomerIntent }
  | { ok: false; intent: SandboxCustomerIntent }
> {
  const ref = intentRef(seed.testRunId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const current = snap.data() as SandboxCustomerIntent;
      return identityMatches(current, seed)
        ? { ok: true as const, intent: current }
        : { ok: false as const, intent: current };
    }
    tx.create(ref, seed);
    return { ok: true as const, intent: seed };
  });
}

async function beginCreation(
  seed: SandboxCustomerIntent,
  attemptId: string,
  now: number,
): Promise<{ acquired: boolean; intent: SandboxCustomerIntent } | null> {
  const ref = intentRef(seed.testRunId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as SandboxCustomerIntent;
    if (!identityMatches(current, seed)) return null;
    if (current.phase !== "reserved" || current.attemptId !== null) {
      return { acquired: false, intent: current };
    }
    const creating: SandboxCustomerIntent = {
      ...current,
      phase: "creating",
      attemptId,
      updatedAt: now,
      lastAttemptAt: now,
      lastError: null,
    };
    tx.update(ref, {
      phase: creating.phase,
      attemptId,
      updatedAt: now,
      lastAttemptAt: now,
      lastError: null,
    });
    return { acquired: true, intent: creating };
  });
}

async function updateIntent(
  seed: SandboxCustomerIntent,
  update: (current: SandboxCustomerIntent) => Partial<SandboxCustomerIntent> | null,
): Promise<SandboxCustomerIntent | null> {
  const ref = intentRef(seed.testRunId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as SandboxCustomerIntent;
    if (!identityMatches(current, seed)) return null;
    const patch = update(current);
    if (!patch) return null;
    tx.update(ref, patch);
    return { ...current, ...patch };
  });
}

function sanitizedError(error: AsaasError): SanitizedCustomerError {
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

function compatibleCustomer(customer: AsaasCustomer, externalReference: string): boolean {
  return (
    CUSTOMER_ID.test(customer.id) &&
    (customer.externalReference === undefined || customer.externalReference === externalReference)
  );
}

async function markSucceeded(
  seed: SandboxCustomerIntent,
  customerId: string,
  now: number,
  expectedAttemptId?: string,
): Promise<SandboxCustomerIntent | null> {
  return updateIntent(seed, (current) => {
    if (current.phase === "conflict" || current.phase === "failed_terminal") return null;
    if (current.externalCustomerId && current.externalCustomerId !== customerId) return null;
    if (current.phase === "succeeded") {
      return current.externalCustomerId === customerId ? {} : null;
    }
    if (expectedAttemptId !== undefined && current.attemptId !== expectedAttemptId) return null;
    return {
      phase: "succeeded",
      externalCustomerId: customerId,
      updatedAt: now,
      lastError: null,
    };
  });
}

async function markConflict(
  seed: SandboxCustomerIntent,
  now: number,
  code: string,
): Promise<SandboxCustomerIntent | null> {
  return updateIntent(seed, (current) => ({
    phase: "conflict",
    updatedAt: now,
    lastError: { kind: "conflict", code },
  }));
}

async function markReconciling(
  seed: SandboxCustomerIntent,
  now: number,
  error: AsaasError | null,
): Promise<SandboxCustomerIntent | null> {
  return updateIntent(seed, (current) => {
    if (
      current.phase === "conflict" ||
      current.phase === "failed_terminal" ||
      current.phase === "succeeded"
    ) {
      return null;
    }
    return {
      phase: "reconciling",
      updatedAt: now,
      ...(error ? { lastError: sanitizedError(error) } : {}),
    };
  });
}

async function reconcileAfterAmbiguousPost(
  seed: SandboxCustomerIntent,
  deps: SandboxCustomerDependencies,
): Promise<SandboxCustomerResult> {
  const lookup = await deps.asaas.findCustomersByExternalReference(seed.externalReference);
  if (!lookup.ok) {
    const intent = await markReconciling(seed, deps.now(), lookup.error);
    return intent
      ? { ok: true, phase: "reconciling", outcome: "lookup_failed", intent }
      : { ok: false, phase: "conflict", reason: "intent_changed" };
  }
  if (lookup.data.length > 1) {
    const intent = await markConflict(seed, deps.now(), "multiple_customers");
    return { ok: false, phase: "conflict", reason: "multiple_customers", intent: intent ?? undefined };
  }
  if (lookup.data.length === 0) {
    const intent = await markReconciling(seed, deps.now(), null);
    return intent
      ? { ok: true, phase: "reconciling", outcome: "awaiting_reconciliation", intent }
      : { ok: false, phase: "conflict", reason: "intent_changed" };
  }
  const customer = lookup.data[0]!;
  if (!compatibleCustomer(customer, seed.externalReference)) {
    const intent = await markConflict(seed, deps.now(), "customer_mismatch");
    return { ok: false, phase: "conflict", reason: "customer_mismatch", intent: intent ?? undefined };
  }
  const intent = await markSucceeded(seed, customer.id, deps.now());
  return intent
    ? { ok: true, phase: "succeeded", outcome: "reconciled", intent }
    : { ok: false, phase: "conflict", reason: "intent_changed" };
}

export async function provisionSandboxCustomer(
  input: ProvisionSandboxCustomerInput,
  deps: SandboxCustomerDependencies,
): Promise<SandboxCustomerResult> {
  const seed = seedIntent(input, deps.now());
  const reservation = await reserveIntent(seed);
  if (!reservation.ok) {
    return { ok: false, phase: "conflict", reason: "identity_conflict", intent: reservation.intent };
  }

  const lookup = await deps.asaas.findCustomersByExternalReference(seed.externalReference);
  if (!lookup.ok) {
    if (reservation.intent.phase === "succeeded") {
      // Uma leitura transitória não desfaz um sucesso durável conhecido.
      // Sinalizamos a falha sanitizada sem qualquer escrita e sem POST.
      return {
        ok: true,
        phase: "succeeded",
        outcome: "verification_failed",
        intent: reservation.intent,
        verificationError: sanitizedError(lookup.error),
      };
    }
    if (
      reservation.intent.phase === "creating" ||
      reservation.intent.phase === "reconciling"
    ) {
      const intent = await markReconciling(seed, deps.now(), lookup.error);
      return intent
        ? { ok: true, phase: "reconciling", outcome: "lookup_failed", intent }
        : { ok: false, phase: "conflict", reason: "intent_changed" };
    }
    if (reservation.intent.phase === "conflict" || reservation.intent.phase === "failed_terminal") {
      return {
        ok: false,
        phase: reservation.intent.phase,
        reason: reservation.intent.phase,
        intent: reservation.intent,
      };
    }
    return { ok: true, phase: reservation.intent.phase as "reserved", outcome: "lookup_failed", intent: reservation.intent };
  }

  if (lookup.data.length > 1) {
    const intent = await markConflict(seed, deps.now(), "multiple_customers");
    return { ok: false, phase: "conflict", reason: "multiple_customers", intent: intent ?? undefined };
  }

  if (lookup.data.length === 1) {
    const customer = lookup.data[0]!;
    if (!compatibleCustomer(customer, seed.externalReference)) {
      const intent = await markConflict(seed, deps.now(), "customer_mismatch");
      return { ok: false, phase: "conflict", reason: "customer_mismatch", intent: intent ?? undefined };
    }
    if (
      reservation.intent.externalCustomerId &&
      reservation.intent.externalCustomerId !== customer.id
    ) {
      const intent = await markConflict(seed, deps.now(), "customer_id_changed");
      return { ok: false, phase: "conflict", reason: "customer_id_changed", intent: intent ?? undefined };
    }
    const intent = await markSucceeded(seed, customer.id, deps.now());
    if (!intent) return { ok: false, phase: "conflict", reason: "intent_changed" };
    return {
      ok: true,
      phase: "succeeded",
      outcome: reservation.intent.phase === "succeeded" ? "verified" : "reconciled",
      intent,
    };
  }

  if (reservation.intent.phase === "conflict" || reservation.intent.phase === "failed_terminal") {
    return {
      ok: false,
      phase: reservation.intent.phase,
      reason: reservation.intent.phase,
      intent: reservation.intent,
    };
  }

  // Uma vez que houve tentativa externa, zero resultados nunca reabre o
  // direito de POST. A única ação permitida é reconciliação read-only.
  if (reservation.intent.phase === "creating" || reservation.intent.phase === "reconciling") {
    const intent = await markReconciling(seed, deps.now(), null);
    return intent
      ? { ok: true, phase: "reconciling", outcome: "awaiting_reconciliation", intent }
      : { ok: false, phase: "conflict", reason: "intent_changed" };
  }

  if (reservation.intent.phase === "succeeded") {
    const intent = await markConflict(seed, deps.now(), "known_customer_missing");
    return { ok: false, phase: "conflict", reason: "known_customer_missing", intent: intent ?? undefined };
  }

  const attemptId = deps.newId();
  const creation = await beginCreation(seed, attemptId, deps.now());
  if (!creation) return { ok: false, phase: "conflict", reason: "intent_changed" };
  if (!creation.acquired) {
    if (creation.intent.phase === "conflict" || creation.intent.phase === "failed_terminal") {
      return {
        ok: false,
        phase: creation.intent.phase,
        reason: creation.intent.phase,
        intent: creation.intent,
      };
    }
    if (creation.intent.phase === "succeeded") {
      return { ok: true, phase: "succeeded", outcome: "verified", intent: creation.intent };
    }
    return {
      ok: true,
      phase: creation.intent.phase as "reserved" | "creating" | "reconciling",
      outcome: "busy",
      intent: creation.intent,
    };
  }

  // Único POST, deliberadamente fora da transaction que concedeu o direito.
  const created = await deps.asaas.createCustomer({
    name: input.name,
    cpfCnpj: input.cpfCnpj,
    externalReference: input.externalReference,
    notificationDisabled: true,
  });

  if (!created.ok) {
    if (isConclusiveHttpRejection(created.error)) {
      const intent = await updateIntent(seed, (current) => {
        if (current.phase !== "creating" || current.attemptId !== attemptId) return null;
        return {
          phase: "failed_terminal",
          updatedAt: deps.now(),
          lastError: sanitizedError(created.error),
        };
      });
      return { ok: false, phase: "failed_terminal", reason: "asaas_rejected", intent: intent ?? undefined };
    }
    const ambiguous = await markReconciling(seed, deps.now(), created.error);
    if (!ambiguous) return { ok: false, phase: "conflict", reason: "intent_changed" };
    return reconcileAfterAmbiguousPost(seed, deps);
  }

  if (!compatibleCustomer(created.data, seed.externalReference)) {
    const ambiguous = await markReconciling(seed, deps.now(), {
      kind: "invalid_response",
      message: "Asaas: resposta de customer incompatível.",
    });
    if (!ambiguous) return { ok: false, phase: "conflict", reason: "intent_changed" };
    return reconcileAfterAmbiguousPost(seed, deps);
  }

  const succeeded = await markSucceeded(seed, created.data.id, deps.now(), attemptId);
  return succeeded
    ? { ok: true, phase: "succeeded", outcome: "created", intent: succeeded }
    : { ok: false, phase: "conflict", reason: "intent_changed" };
}

export async function getSandboxCustomerIntent(testRunId: string): Promise<SandboxCustomerIntent | null> {
  const snap = await intentRef(testRunId).get();
  return snap.exists ? (snap.data() as SandboxCustomerIntent) : null;
}
