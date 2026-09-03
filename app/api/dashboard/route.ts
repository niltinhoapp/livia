// GET /api/dashboard?from=<epoch>&to=<epoch> -> métricas do painel diário
// (Passo 13). `from`/`to` definem "hoje" no fuso do NAVEGADOR do dono (mesmo
// padrão de GET /api/appointments) — calcular no servidor usaria o fuso do
// processo (UTC na Vercel), errando a virada do dia no Brasil.
//
// Só consultas/agregações determinísticas (ver lib/dashboard.ts) — nenhuma
// chamada à OpenAI nesta rota.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getDashboardMetrics } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const now = Date.now();
  const from = Number(req.nextUrl.searchParams.get("from")) || now - 24 * 3600000;
  const to = Number(req.nextUrl.searchParams.get("to")) || now;

  const metrics = await getDashboardMetrics(id, from, to);
  return NextResponse.json(metrics);
}
