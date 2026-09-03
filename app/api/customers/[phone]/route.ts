// GET /api/customers/:phone -> ficha completa de um cliente (Passo 10):
// perfil + resumo da conversa + pendência atual + situação do
// relacionamento. `:phone` pode vir cru (com formatação) — normalizado no
// mesmo lugar que todo o resto do sistema usa (lib/dashboard.ts).
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getCustomerDetail } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { phone: string } }) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const detail = await getCustomerDetail(id, decodeURIComponent(params.phone));
  if (!detail) return NextResponse.json({ error: "cliente não encontrado" }, { status: 404 });
  return NextResponse.json(detail);
}
