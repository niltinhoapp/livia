// GET /api/opportunities -> lista de oportunidades detectadas (Passo 12) —
// sempre derivada de pendências/intenção/agendamentos reais (ver
// lib/ai/opportunities.ts), nunca inventada.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getOpportunities } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const opportunities = await getOpportunities(id);
  return NextResponse.json({ opportunities });
}
