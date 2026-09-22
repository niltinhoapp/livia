import { NextRequest, NextResponse } from "next/server";
import { completeMercadoPagoOAuth, PaymentConnectionError } from "@/lib/payments/mercadoPagoOAuth";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code"); const state = req.nextUrl.searchParams.get("state");
  const result = new URL("/painel/pagamentos", req.url);
  if (!code || !state) { result.searchParams.set("connection", "invalid"); return NextResponse.redirect(result); }
  try { await completeMercadoPagoOAuth(code, state); result.searchParams.set("connection", "connected"); }
  catch (error) { result.searchParams.set("connection", error instanceof PaymentConnectionError ? error.code : "error"); }
  return NextResponse.redirect(result);
}
