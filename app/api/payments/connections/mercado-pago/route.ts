import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { beginMercadoPagoOAuth, disconnectMercadoPago, getMercadoPagoConnection, PaymentConnectionError } from "@/lib/payments/mercadoPagoOAuth";

function publicConnection(connection: Awaited<ReturnType<typeof getMercadoPagoConnection>>) {
  if (!connection) return null;
  return { id: connection.id, provider: connection.provider, status: connection.status, providerAccountId: connection.providerAccountId, scopes: connection.scopes, connectedAt: connection.connectedAt, disconnectedAt: connection.disconnectedAt, expiresAt: connection.expiresAt, createdAt: connection.createdAt, updatedAt: connection.updatedAt };
}

export async function GET(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  return NextResponse.json({ connection: publicConnection(await getMercadoPagoConnection(establishmentId)) });
}

export async function POST(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  try { return NextResponse.json(await beginMercadoPagoOAuth(establishmentId)); }
  catch (error) { return NextResponse.json({ error: error instanceof PaymentConnectionError ? error.code : "connection_error" }, { status: 503 }); }
}

export async function DELETE(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  try { await disconnectMercadoPago(establishmentId); return NextResponse.json({ disconnected: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof PaymentConnectionError ? error.code : "connection_error" }, { status: 400 }); }
}
