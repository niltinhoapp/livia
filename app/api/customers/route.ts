// GET /api/customers -> lista de perfis de cliente (Passo 10 — CRM), mais
// recentes primeiro. Só os campos do CustomerProfile — sem junção com
// conversas/agendamentos/pendências (isso é a rota de detalhe, sob demanda).
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { listCustomers } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const customers = await listCustomers(id);
  return NextResponse.json({ customers });
}
