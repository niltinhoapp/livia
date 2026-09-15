import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { requirePlatformAdmin } from "@/lib/auth/platformAdmin";
import {
  changePanelAccess,
  provisionPanelAccess,
  type PanelAccessFailureReason,
  type PanelAccessState,
} from "@/lib/panelAccess";

const SAFE_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const STATES: PanelAccessState[] = ["absent", "legacy", "allowed", "blocked"];

type Command =
  | {
      action: "provision";
      targetUid: string;
      expectedPanelAccess: PanelAccessState;
      requestId: string;
    }
  | {
      action: "grant" | "revoke";
      establishmentId: string;
      ownerUid: string;
      expectedPanelAccess: Exclude<PanelAccessState, "absent">;
      requestId: string;
    };

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeString(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value === value.trim() && pattern.test(value);
}

function parseCommand(value: unknown): Command | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  if (raw.action === "provision") {
    if (!exactKeys(raw, ["action", "targetUid", "expectedPanelAccess", "requestId"])) return null;
    if (!safeString(raw.targetUid, SAFE_ID) || !safeString(raw.requestId, REQUEST_ID)) return null;
    if (!STATES.includes(raw.expectedPanelAccess as PanelAccessState)) return null;
    return raw as Command;
  }

  if (raw.action === "grant" || raw.action === "revoke") {
    if (!exactKeys(raw, ["action", "establishmentId", "ownerUid", "expectedPanelAccess", "requestId"])) {
      return null;
    }
    if (
      !safeString(raw.establishmentId, SAFE_ID) ||
      !safeString(raw.ownerUid, SAFE_ID) ||
      !safeString(raw.requestId, REQUEST_ID)
    ) {
      return null;
    }
    if (!STATES.includes(raw.expectedPanelAccess as PanelAccessState) || raw.expectedPanelAccess === "absent") {
      return null;
    }
    return raw as Command;
  }

  return null;
}

function failureStatus(reason: PanelAccessFailureReason): number {
  if (reason === "target_user_not_found" || reason === "establishment_not_found") return 404;
  return 409;
}

export async function POST(req: NextRequest) {
  const authority = await requirePlatformAdmin(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (authority.status === "unauthenticated") {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (authority.status !== "authorized") {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const command = parseCommand(await req.json().catch(() => null));
  if (!command) return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });

  const targetOwnerUid = command.action === "provision" ? command.targetUid : command.ownerUid;
  if (command.action !== "revoke" && targetOwnerUid === authority.actorUid) {
    return NextResponse.json({ error: "SELF_GRANT_FORBIDDEN" }, { status: 403 });
  }

  try {
    const result = command.action === "provision"
      ? await provisionPanelAccess({ ...command, actorUid: authority.actorUid })
      : await changePanelAccess({ ...command, actorUid: authority.actorUid });

    if (!result.ok) {
      return NextResponse.json({ error: result.reason.toUpperCase() }, { status: failureStatus(result.reason) });
    }
    return NextResponse.json(result, { status: result.outcome === "created" ? 201 : 200 });
  } catch {
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
