import { randomUUID } from "node:crypto";
import { db, sub } from "@/lib/firebase/admin";
import type { Conversation, WhatsAppOutboundIntent } from "@/types";

const CLAIM_TTL_MS = 2 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 1000;

export class OutboundRetryableError extends Error {
  constructor(public readonly code: string, public readonly nextAttemptAt?: number) {
    super(code);
    this.name = "OutboundRetryableError";
  }
}

export class OutboundReconciliationRequiredError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "OutboundReconciliationRequiredError";
  }
}

export class OutboundIntentConflictError extends Error {
  constructor() {
    super("outbound_intent_payload_conflict");
    this.name = "OutboundIntentConflictError";
  }
}

export interface DurableOutboundInput {
  jobId: string;
  establishmentId: string;
  conversationId: string;
  leaseId: string;
  allowedStatuses: Conversation["status"][];
  toPhone: string;
  whatsappPhoneNumberId: string;
  text: string;
  preferVoice: boolean;
  prospectingAction?: any;
}

type ClaimResult =
  | { kind: "claimed"; claimId: string }
  | { kind: "confirmed"; intent: WhatsAppOutboundIntent }
  | { kind: "suppressed" }
  | { kind: "retry"; nextAttemptAt: number }
  | { kind: "reconciliation"; code: string }
  | { kind: "conflict" };

const intentRef = (jobId: string) => db.collection("_wa_outbound_intents").doc(jobId);

function samePayload(intent: WhatsAppOutboundIntent, input: DurableOutboundInput): boolean {
  return intent.establishmentId === input.establishmentId &&
    intent.conversationId === input.conversationId &&
    intent.toPhone === input.toPhone &&
    intent.whatsappPhoneNumberId === input.whatsappPhoneNumberId &&
    intent.text === input.text &&
    intent.preferVoice === input.preferVoice;
}

async function claimOutbound(input: DurableOutboundInput, now: number): Promise<ClaimResult> {
  const ref = intentRef(input.jobId);
  const conversationRef = sub(input.establishmentId, "conversations").doc(input.conversationId);
  const claimId = randomUUID();
  return db.runTransaction(async (tx) => {
    const [intentSnap, conversationSnap] = await Promise.all([tx.get(ref), tx.get(conversationRef)]);
    const existing = intentSnap.exists ? intentSnap.data() as WhatsAppOutboundIntent : null;
    if (existing?.state === "confirmed") return { kind: "confirmed", intent: existing };
    if (existing && !samePayload(existing, input)) {
      tx.update(ref, {
        state: "reconciliation_required",
        lastErrorCode: "outbound_intent_payload_conflict",
        claimId: null,
        claimExpiresAt: null,
        updatedAt: now,
      });
      return { kind: "conflict" };
    }
    if (existing?.state === "reconciliation_required") {
      return { kind: "reconciliation", code: existing.lastErrorCode ?? "outbound_reconciliation_required" };
    }
    if (existing?.state === "sending") {
      if (Number(existing.claimExpiresAt ?? 0) > now) {
        return { kind: "retry", nextAttemptAt: Number(existing.claimExpiresAt) };
      }
      tx.update(ref, {
        state: "reconciliation_required",
        lastErrorCode: "outbound_claim_expired_after_possible_send",
        claimId: null,
        claimExpiresAt: null,
        updatedAt: now,
      });
      return { kind: "reconciliation", code: "outbound_claim_expired_after_possible_send" };
    }
    if (existing && existing.nextAttemptAt > now) {
      return { kind: "retry", nextAttemptAt: existing.nextAttemptAt };
    }

    const conversation = conversationSnap.exists ? conversationSnap.data() as Conversation : null;
    const lease = conversation?.aiProcessingLease;
    if (
      !conversation ||
      !input.allowedStatuses.includes(conversation.status) ||
      !lease ||
      lease.leaseId !== input.leaseId ||
      lease.expiresAt <= now
    ) return { kind: "suppressed" };

    const base: WhatsAppOutboundIntent = existing ?? {
      id: input.jobId,
      inboundJobId: input.jobId,
      establishmentId: input.establishmentId,
      conversationId: input.conversationId,
      toPhone: input.toPhone,
      whatsappPhoneNumberId: input.whatsappPhoneNumberId,
      text: input.text,
      preferVoice: input.preferVoice,
      ...(input.prospectingAction ? { prospectingAction: input.prospectingAction } : {}),
      state: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(ref, {
      ...base,
      state: "sending",
      attempts: Number(base.attempts ?? 0) + 1,
      claimId,
      claimExpiresAt: now + CLAIM_TTL_MS,
      lastErrorCode: null,
      updatedAt: now,
    });
    return { kind: "claimed", claimId };
  });
}

async function confirmOutbound(jobId: string, claimId: string, waMessageId: string | undefined, now: number): Promise<void> {
  const ref = intentRef(jobId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("outbound_intent_missing");
    const intent = snap.data() as WhatsAppOutboundIntent;
    if (intent.state === "confirmed") return;
    if (intent.state !== "sending" || intent.claimId !== claimId) {
      throw new OutboundReconciliationRequiredError("outbound_claim_lost_after_send");
    }
    tx.update(ref, {
      state: "confirmed",
      waMessageId: waMessageId ?? null,
      claimId: null,
      claimExpiresAt: null,
      lastErrorCode: null,
      updatedAt: now,
    });
  });
}

async function failOutbound(jobId: string, claimId: string, code: string, ambiguous: boolean, now: number): Promise<void> {
  const ref = intentRef(jobId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const intent = snap.data() as WhatsAppOutboundIntent;
    if (intent.state !== "sending" || intent.claimId !== claimId) return;
    tx.update(ref, ambiguous ? {
      state: "reconciliation_required",
      lastErrorCode: code,
      claimId: null,
      claimExpiresAt: null,
      updatedAt: now,
    } : {
      state: "pending",
      nextAttemptAt: now + RETRY_DELAY_MS,
      lastErrorCode: code,
      claimId: null,
      claimExpiresAt: null,
      updatedAt: now,
    });
  });
}

export async function getWhatsAppOutboundIntent(jobId: string): Promise<WhatsAppOutboundIntent | null> {
  const snap = await intentRef(jobId).get();
  return snap.exists ? snap.data() as WhatsAppOutboundIntent : null;
}

export async function executeDurableWhatsAppOutbound(
  input: DurableOutboundInput,
  sender: () => Promise<{ waMessageId?: string }>,
  classifyError: (error: unknown) => { code: string; ambiguous: boolean },
  now = Date.now(),
): Promise<{ waMessageId?: string; text: string } | null> {
  const claim = await claimOutbound(input, now);
  if (claim.kind === "confirmed") {
    return { ...(claim.intent.waMessageId ? { waMessageId: claim.intent.waMessageId } : {}), text: claim.intent.text };
  }
  if (claim.kind === "suppressed") return null;
  if (claim.kind === "retry") throw new OutboundRetryableError("outbound_not_ready", claim.nextAttemptAt);
  if (claim.kind === "conflict") throw new OutboundIntentConflictError();
  if (claim.kind === "reconciliation") throw new OutboundReconciliationRequiredError(claim.code);

  try {
    const sent = await sender();
    await confirmOutbound(input.jobId, claim.claimId, sent.waMessageId, Date.now());
    return { ...sent, text: input.text };
  } catch (error) {
    if (error instanceof OutboundReconciliationRequiredError) throw error;
    const failure = classifyError(error);
    await failOutbound(input.jobId, claim.claimId, failure.code, failure.ambiguous, Date.now());
    if (failure.ambiguous) throw new OutboundReconciliationRequiredError(failure.code);
    throw new OutboundRetryableError(failure.code, Date.now() + RETRY_DELAY_MS);
  }
}
