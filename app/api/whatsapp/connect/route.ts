// GET  /api/whatsapp/connect -> status da conexão de WhatsApp (painel).
// POST /api/whatsapp/connect -> finaliza o Embedded Signup.
//
// Tenant SEMPRE via resolveEstablishmentId(req) (sessão) — nunca aceito do
// corpo da requisição.
//
// O fluxo Cloud API existente permanece intacto por padrão. Coexistence é
// opt-in explícito pelo frontend e só muda o passo /register: nesse modo a
// Meta já controla o vínculo do número com o WhatsApp Business App.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import {
  getEstablishment,
  claimWhatsappConnection,
  finalizeWhatsappConnection,
  releaseWhatsappConnectionAttempt,
} from "@/lib/repo";
import {
  exchangeCodeForToken,
  getWabaPhoneNumbers,
  subscribeAppToWaba,
  registerPhoneNumber,
  graphErrorOf,
} from "@/lib/whatsapp/embedded";
import { encryptToken } from "@/lib/whatsapp/tokenCrypto";
import { normalizeConnectionMode } from "@/lib/whatsapp/coexistence";

const ID_PATTERN = /^\d+$/;

function logFailure(step: string, establishmentId: string, err?: unknown): void {
  const graph = err !== undefined ? graphErrorOf(err) : undefined;
  const detail = graph ? ` graph=${JSON.stringify(graph)}` : "";
  console.error(
    `[whatsapp connect] falha em "${step}" (estabelecimento=${establishmentId})${detail}`,
  );
}

async function abort(
  id: string,
  attemptId: string,
  step: string,
  errorCode: string,
  status: number,
  err?: unknown,
): Promise<NextResponse> {
  logFailure(step, id, err);
  await releaseWhatsappConnectionAttempt(id, attemptId).catch(() => {});
  return NextResponse.json({ error: errorCode }, { status });
}

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const est = await getEstablishment(id);
  const wa = est?.whatsapp;
  if (!wa || wa.status !== "connected") {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    phoneNumberId: wa.phoneNumberId,
    wabaId: wa.wabaId,
    connectedAt: wa.connectedAt,
    tokenRefreshedAt: wa.tokenRefreshedAt,
    connectionMode: normalizeConnectionMode(wa.connectionMode),
  });
}

export async function POST(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const raw = (await req.json().catch(() => null)) as {
    code?: unknown;
    wabaId?: unknown;
    phoneNumberId?: unknown;
    connectionMode?: unknown;
  } | null;
  const code = raw?.code;
  const wabaId = raw?.wabaId;
  const phoneNumberId = raw?.phoneNumberId;
  const connectionMode = normalizeConnectionMode(raw?.connectionMode);

  if (
    typeof code !== "string" ||
    !code ||
    typeof wabaId !== "string" ||
    !ID_PATTERN.test(wabaId) ||
    typeof phoneNumberId !== "string" ||
    !ID_PATTERN.test(phoneNumberId)
  ) {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }

  let claim: Awaited<ReturnType<typeof claimWhatsappConnection>>;
  try {
    claim = await claimWhatsappConnection(id, wabaId, phoneNumberId);
  } catch (err) {
    logFailure("claim", id, err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
  if (claim.outcome === "already_connected") {
    return NextResponse.json({ error: "ALREADY_CONNECTED" }, { status: 409 });
  }
  if (claim.outcome === "conflict") {
    return NextResponse.json({ error: "CONNECTION_IN_PROGRESS" }, { status: 409 });
  }
  if (claim.outcome === "number_in_use") {
    logFailure("claim (número já conectado em outro estabelecimento)", id);
    return NextResponse.json({ error: "NUMBER_IN_USE" }, { status: 409 });
  }

  const { pin, attemptId } = claim;

  let accessToken: string;
  try {
    accessToken = await exchangeCodeForToken(code);
  } catch (err) {
    return abort(id, attemptId, "exchange", "EXCHANGE_FAILED", 502, err);
  }

  try {
    const numbers = await getWabaPhoneNumbers(wabaId, accessToken);
    if (!numbers.includes(phoneNumberId)) {
      return abort(id, attemptId, "ownership (phoneNumberId fora da lista da WABA)", "OWNERSHIP_MISMATCH", 502);
    }
  } catch (err) {
    return abort(id, attemptId, "ownership", "OWNERSHIP_MISMATCH", 502, err);
  }

  try {
    await subscribeAppToWaba(wabaId, accessToken);
  } catch (err) {
    return abort(id, attemptId, "subscribe", "SUBSCRIBE_FAILED", 502, err);
  }

  // Cloud API mantém exatamente o comportamento anterior. Coexistence não
  // chama /register: o número continua vinculado ao WhatsApp Business App.
  let registeredAt: number | undefined;
  if (connectionMode === "cloud_api") {
    try {
      const result = await registerPhoneNumber(phoneNumberId, accessToken, pin);
      if (result.registered) registeredAt = Date.now();
    } catch (err) {
      return abort(id, attemptId, "register", "REGISTER_FAILED", 502, err);
    }
  }

  let finalized: { ok: boolean };
  try {
    finalized = await finalizeWhatsappConnection(id, attemptId, {
      wabaId,
      phoneNumberId,
      accessToken: encryptToken(accessToken),
      connectionMode,
      registeredAt,
    });
  } catch (err) {
    return abort(id, attemptId, "finalize", "INTERNAL_ERROR", 500, err);
  }

  if (!finalized.ok) {
    logFailure("finalize (lease perdida para outra tentativa)", id);
    return NextResponse.json({ error: "STALE_ATTEMPT" }, { status: 409 });
  }

  return NextResponse.json({ connected: true, phoneNumberId, wabaId, connectionMode });
}
