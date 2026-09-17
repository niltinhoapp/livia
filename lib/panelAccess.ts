// Provisionamento administrativo de panelAccess. Este módulo não toca
// whatsappBeta, Meta ou dados operacionais do tenant.
import { getAuth } from "firebase-admin/auth";
import { db, establishmentRef, firebaseAdminApp } from "@/lib/firebase/admin";
import { defaultBotConfig, initialTrialBilling } from "@/lib/repo";
import type { Establishment, PanelAccess } from "@/types";

export type PanelAccessState = "absent" | "legacy" | PanelAccess;
export type PanelAccessAdminAction = "provision" | "grant" | "revoke";

export interface PanelAccessAuditEvent {
  action: PanelAccessAdminAction;
  actorUid: string;
  establishmentId: string;
  ownerUid: string;
  before: PanelAccessState;
  after: PanelAccess;
  expected: PanelAccessState;
  createdAt: number;
  requestId: string;
}

type PanelAccessEventIdentity = Omit<PanelAccessAuditEvent, "before" | "createdAt">;

export type PanelAccessFailureReason =
  | "target_user_not_found"
  | "establishment_not_found"
  | "multiple_establishments"
  | "owner_uid_mismatch"
  | "state_conflict"
  | "request_id_conflict"
  | "invalid_persisted_state";

export type PanelAccessOperationResult =
  | {
      ok: true;
      establishmentId: string;
      panelAccess: PanelAccess;
      outcome: "created" | "updated" | "unchanged" | "replayed";
    }
  | { ok: false; reason: PanelAccessFailureReason };

export interface ProvisionPanelAccessInput {
  actorUid: string;
  targetUid: string;
  expectedPanelAccess: PanelAccessState;
  requestId: string;
}

export interface ChangePanelAccessInput {
  action: "grant" | "revoke";
  actorUid: string;
  establishmentId: string;
  ownerUid: string;
  expectedPanelAccess: Exclude<PanelAccessState, "absent">;
  requestId: string;
}

function stateOf(tenant: Establishment | undefined): PanelAccessState | null {
  if (!tenant) return "absent";
  if (tenant.panelAccess === undefined) return "legacy";
  if (tenant.panelAccess === "allowed" || tenant.panelAccess === "blocked") return tenant.panelAccess;
  return null;
}

function eventMatches(
  event: Partial<PanelAccessAuditEvent>,
  expected: PanelAccessEventIdentity,
): event is PanelAccessAuditEvent {
  return (
    event.action === expected.action &&
    event.actorUid === expected.actorUid &&
    event.establishmentId === expected.establishmentId &&
    event.ownerUid === expected.ownerUid &&
    event.after === expected.after &&
    event.expected === expected.expected &&
    event.requestId === expected.requestId
  );
}

function replayResult(
  event: Partial<PanelAccessAuditEvent>,
  expected: PanelAccessEventIdentity,
): PanelAccessOperationResult {
  if (!eventMatches(event, expected)) return { ok: false, reason: "request_id_conflict" };
  return {
    ok: true,
    establishmentId: expected.establishmentId,
    panelAccess: expected.after,
    outcome: "replayed",
  };
}

function requestIdentity(identity: PanelAccessEventIdentity): string {
  return JSON.stringify([
    identity.action,
    identity.actorUid,
    identity.establishmentId,
    identity.ownerUid,
    identity.after,
    identity.expected,
    identity.requestId,
  ]);
}

function reservationMatches(
  reservation: Record<string, unknown> | undefined,
  identity: PanelAccessEventIdentity,
): boolean {
  return reservation?.identity === requestIdentity(identity);
}

function requestReservationRef(requestId: string) {
  // Índice global de unicidade do requestId. O evento no tenant continua
  // sendo a auditoria canônica; ambos são criados na mesma transação.
  return db
    .collection("_system")
    .doc("panel-access-idempotency-v1")
    .collection("requests")
    .doc(requestId);
}

async function firebaseUserExists(uid: string): Promise<boolean> {
  try {
    await getAuth(firebaseAdminApp).getUser(uid);
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "auth/user-not-found") return false;
    throw error;
  }
}

export async function provisionPanelAccess(
  input: ProvisionPanelAccessInput,
): Promise<PanelAccessOperationResult> {
  if (!(await firebaseUserExists(input.targetUid))) {
    return { ok: false, reason: "target_user_not_found" };
  }

  return db.runTransaction(async (tx) => {
    const owners = await tx.get(
      db.collection("establishments").where("ownerUid", "==", input.targetUid).limit(2),
    );
    if (owners.size > 1) return { ok: false, reason: "multiple_establishments" as const };

    let establishmentId = input.targetUid;
    let tenant: Establishment | undefined;
    if (owners.size === 1) {
      establishmentId = owners.docs[0]!.id;
      tenant = owners.docs[0]!.data() as Establishment;
    } else {
      const deterministicSnap = await tx.get(establishmentRef(establishmentId));
      if (deterministicSnap.exists) {
        tenant = deterministicSnap.data() as Establishment;
        if (tenant.ownerUid !== input.targetUid) {
          return { ok: false, reason: "owner_uid_mismatch" as const };
        }
      }
    }

    const ref = establishmentRef(establishmentId);
    const eventRef = ref.collection("panelAccessEvents").doc(input.requestId);
    const reservationRef = requestReservationRef(input.requestId);
    const [eventSnap, reservationSnap] = await Promise.all([
      tx.get(eventRef),
      tx.get(reservationRef),
    ]);
    const eventIdentity = {
      action: "provision" as const,
      actorUid: input.actorUid,
      establishmentId,
      ownerUid: input.targetUid,
      after: "allowed" as const,
      expected: input.expectedPanelAccess,
      requestId: input.requestId,
    };
    if (eventSnap.exists || reservationSnap.exists) {
      if (
        reservationSnap.exists &&
        !reservationMatches(reservationSnap.data() as Record<string, unknown>, eventIdentity)
      ) {
        return { ok: false, reason: "request_id_conflict" as const };
      }
      if (
        eventSnap.exists &&
        !eventMatches(eventSnap.data() as Partial<PanelAccessAuditEvent>, eventIdentity)
      ) {
        return { ok: false, reason: "request_id_conflict" as const };
      }
      if (!eventSnap.exists || !reservationSnap.exists) {
        return { ok: false, reason: "invalid_persisted_state" as const };
      }
      return replayResult(eventSnap.data() as Partial<PanelAccessAuditEvent>, eventIdentity);
    }

    const before = stateOf(tenant);
    if (before === null) return { ok: false, reason: "invalid_persisted_state" as const };
    if (before !== input.expectedPanelAccess) return { ok: false, reason: "state_conflict" as const };
    const event: PanelAccessAuditEvent = {
      ...eventIdentity,
      before,
      createdAt: Date.now(),
    };
    if (before === "allowed") {
      tx.create(reservationRef, { identity: requestIdentity(eventIdentity) });
      tx.create(eventRef, event);
      return {
        ok: true,
        establishmentId,
        panelAccess: "allowed" as const,
        outcome: "unchanged" as const,
      };
    }

    const now = event.createdAt;
    if (!tenant) {
      const created: Establishment = {
        id: establishmentId,
        name: "",
        type: "outro",
        ownerUid: input.targetUid,
        status: "active",
        createdAt: now,
        billing: initialTrialBilling(now),
        panelAccess: "allowed",
        bot: defaultBotConfig(),
      };
      tx.create(ref, created);
    } else {
      tx.update(ref, { panelAccess: "allowed" });
    }
    tx.create(reservationRef, { identity: requestIdentity(eventIdentity) });
    tx.create(eventRef, event);

    return {
      ok: true,
      establishmentId,
      panelAccess: "allowed" as const,
      outcome: tenant ? ("updated" as const) : ("created" as const),
    };
  });
}

export async function changePanelAccess(
  input: ChangePanelAccessInput,
): Promise<PanelAccessOperationResult> {
  // Revogar continua possível mesmo se a conta Firebase já tiver sido
  // removida; conceder acesso, porém, exige uma identidade alvo existente.
  if (input.action === "grant" && !(await firebaseUserExists(input.ownerUid))) {
    return { ok: false, reason: "target_user_not_found" };
  }

  const targetAccess: PanelAccess = input.action === "grant" ? "allowed" : "blocked";
  const ref = establishmentRef(input.establishmentId);
  const eventRef = ref.collection("panelAccessEvents").doc(input.requestId);
  const reservationRef = requestReservationRef(input.requestId);

  return db.runTransaction(async (tx) => {
    const [tenantSnap, eventSnap, reservationSnap] = await Promise.all([
      tx.get(ref),
      tx.get(eventRef),
      tx.get(reservationRef),
    ]);
    if (!tenantSnap.exists) return { ok: false, reason: "establishment_not_found" as const };

    const tenant = tenantSnap.data() as Establishment;
    const eventIdentity = {
      action: input.action,
      actorUid: input.actorUid,
      establishmentId: input.establishmentId,
      ownerUid: input.ownerUid,
      after: targetAccess,
      expected: input.expectedPanelAccess,
      requestId: input.requestId,
    };
    if (eventSnap.exists || reservationSnap.exists) {
      if (
        reservationSnap.exists &&
        !reservationMatches(reservationSnap.data() as Record<string, unknown>, eventIdentity)
      ) {
        return { ok: false, reason: "request_id_conflict" as const };
      }
      if (
        eventSnap.exists &&
        !eventMatches(eventSnap.data() as Partial<PanelAccessAuditEvent>, eventIdentity)
      ) {
        return { ok: false, reason: "request_id_conflict" as const };
      }
      if (!eventSnap.exists || !reservationSnap.exists) {
        return { ok: false, reason: "invalid_persisted_state" as const };
      }
      const replay = replayResult(eventSnap.data() as Partial<PanelAccessAuditEvent>, eventIdentity);
      if (!replay.ok) return replay;
      if (tenant.ownerUid !== input.ownerUid) {
        return { ok: false, reason: "owner_uid_mismatch" as const };
      }
      return replay;
    }

    if (tenant.ownerUid !== input.ownerUid) {
      return { ok: false, reason: "owner_uid_mismatch" as const };
    }

    const before = stateOf(tenant);
    if (before === null || before === "absent") {
      return { ok: false, reason: "invalid_persisted_state" as const };
    }
    if (before !== input.expectedPanelAccess) return { ok: false, reason: "state_conflict" as const };

    const event: PanelAccessAuditEvent = {
      ...eventIdentity,
      before,
      createdAt: Date.now(),
    };
    if (before === targetAccess) {
      tx.create(reservationRef, { identity: requestIdentity(eventIdentity) });
      tx.create(eventRef, event);
      return {
        ok: true,
        establishmentId: input.establishmentId,
        panelAccess: targetAccess,
        outcome: "unchanged" as const,
      };
    }

    tx.update(ref, { panelAccess: targetAccess });
    tx.create(reservationRef, { identity: requestIdentity(eventIdentity) });
    tx.create(eventRef, event);

    return {
      ok: true,
      establishmentId: input.establishmentId,
      panelAccess: targetAccess,
      outcome: "updated" as const,
    };
  });
}
