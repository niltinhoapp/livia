
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { normalizePhone } from "@/lib/whatsapp/client";
import { transitionProspectingSession } from "@/lib/repo";

export const dynamic = "force-dynamic";

function authenticate(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_PROSPECTING_SECRET;
  if (!secret) return false;

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;

  const token = authHeader.substring(7);
  const bufToken = Buffer.from(token);
  const bufSecret = Buffer.from(secret);
  return bufToken.length === bufSecret.length && timingSafeEqual(bufToken, bufSecret);
}

function getEstablishmentId(): string | null {
  return process.env.INTERNAL_PROSPECTING_ESTABLISHMENT_ID || null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { phone: string } }
) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const establishmentId = getEstablishmentId();
  if (!establishmentId) {
    return NextResponse.json({ error: "INTERNAL_CONFIGURATION_ERROR" }, { status: 500 });
  }

  const rawPhone = params.phone;
  const normalizedPhone = normalizePhone(rawPhone);
  if (!normalizedPhone) {
    return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }

  const { action } = body as Record<string, unknown>;

  if (action !== "confirm_manual_send" && action !== "abort") {
    return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
  }

  try {
    const session = await transitionProspectingSession(establishmentId, normalizedPhone, { action });
    if (!session) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ session }, { status: 200 });
  } catch (err: any) {
    if (err.message === "invalid_transition_terminal_state") {
      return NextResponse.json({ error: "CONFLICT", details: err.message }, { status: 409 });
    }
    console.error("[PATCH /api/internal/prospecting/[phone]] Error:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

