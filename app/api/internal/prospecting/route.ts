
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { normalizePhone } from "@/lib/whatsapp/client";
import { upsertProspectingSession, getProspectingSessionByLeadId } from "@/lib/repo";

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

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const establishmentId = getEstablishmentId();
  if (!establishmentId) {
    return NextResponse.json({ error: "INTERNAL_CONFIGURATION_ERROR" }, { status: 500 });
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

  const { leadId, phone, businessName, segment, initialManualMessage } = body as Record<string, unknown>;

  if (typeof leadId !== "string" || !leadId.trim() || leadId.length > 128) {
    return NextResponse.json({ error: "INVALID_PAYLOAD", details: "leadId must be a string up to 128 chars" }, { status: 400 });
  }
  if (typeof phone !== "string" || phone.trim().length < 8 || phone.length > 32) {
    return NextResponse.json({ error: "INVALID_PAYLOAD", details: "phone must be a string up to 32 chars" }, { status: 400 });
  }
  if (typeof businessName !== "string" || !businessName.trim() || businessName.length > 256) {
    return NextResponse.json({ error: "INVALID_PAYLOAD", details: "businessName must be a string up to 256 chars" }, { status: 400 });
  }
  if (typeof segment !== "string" || !segment.trim() || segment.length > 128) {
    return NextResponse.json({ error: "INVALID_PAYLOAD", details: "segment must be a string up to 128 chars" }, { status: 400 });
  }
  if (typeof initialManualMessage !== "string" || !initialManualMessage.trim() || initialManualMessage.length > 4096) {
    return NextResponse.json({ error: "INVALID_PAYLOAD", details: "initialManualMessage must be a string up to 4096 chars" }, { status: 400 });
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || normalizedPhone.length < 10) {
    return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  }

  try {
    const now = Date.now();
    const session = await upsertProspectingSession(establishmentId, {
      leadId,
      phone: normalizedPhone,
      businessName,
      segment,
      initialManualMessage,
      now,
    });
    
    // Idempotency: HTTP 200 se a sesso j existia igual (createdAt !== updatedAt). HTTP 201 se acabou de criar.
    const isNew = session.createdAt === now && session.status === "PREPARED";
    
    return NextResponse.json({ session }, { status: isNew ? 201 : 200 });
  } catch (err: any) {
    if (
      err.message === "conflict_lead_id_different_phone" ||
      err.message === "conflict_active_session" ||
      err.message === "opted_out"
    ) {
      return NextResponse.json({ error: "CONFLICT", details: err.message }, { status: 409 });
    }
    console.error("[POST /api/internal/prospecting] Error:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const establishmentId = getEstablishmentId();
  if (!establishmentId) {
    return NextResponse.json({ error: "INTERNAL_CONFIGURATION_ERROR" }, { status: 500 });
  }

  const leadId = req.nextUrl.searchParams.get("leadId");
  if (!leadId || typeof leadId !== "string" || leadId.trim().length === 0 || leadId.length > 128) {
    return NextResponse.json({ error: "INVALID_LEAD_ID" }, { status: 400 });
  }

  try {
    const session = await getProspectingSessionByLeadId(establishmentId, leadId);
    if (!session) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    return NextResponse.json({ session }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/internal/prospecting] Error:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

