// Operação do ambiente oficial de demonstração (F2).
//
// Superfície interna, autenticada pelo MESMO segredo de
// /api/internal/prospecting (INTERNAL_PROSPECTING_SECRET, comparação em tempo
// constante). Nunca exposta a usuário final e nunca aceita um
// establishmentId do corpo: o tenant vem SEMPRE de
// INTERNAL_DEMO_PROSPECTING_ESTABLISHMENT_ID, pelo mesmo motivo documentado em
// lib/prospectingChannel.ts — não é permitido escolher establishment
// arbitrário.
//
// É o que torna o ambiente de demonstração "explícito e resetável" em vez de
// mágico:
//
//   POST { action: "provision" }          semeia cardápio + cenário default
//   POST { action: "reset_scenario" }     volta o cenário ao default
//   POST { action: "reset_session", leadId }
//                                         apaga os registros demo de UM lead
//   POST { action: "cleanup_expired" }    apaga resíduo de sessões vencidas
//   GET                                   inspeciona o cenário atual
//
// `reset_session` e `cleanup_expired` são escopados por prospectingLeadId:
// limpar a sessão de um prospect nunca alcança a de outro, e nenhuma query
// consegue tocar produção porque todas exigem mode == "demo".
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prospectingEstablishmentId } from "@/lib/prospectingChannel";
import { seedDemoCatalog } from "@/lib/demo/catalog";
import { cleanupDemoSession, getDemoScenario, listExpiredDemoLeads, resetDemoScenario } from "@/lib/demo/store";

export const dynamic = "force-dynamic";

function authenticate(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_PROSPECTING_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function demoEstablishmentId(): string | null {
  return prospectingEstablishmentId("demo");
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const establishmentId = demoEstablishmentId();
  if (!establishmentId) return NextResponse.json({ error: "INTERNAL_CONFIGURATION_ERROR" }, { status: 500 });
  return NextResponse.json({ establishmentId, scenario: await getDemoScenario(establishmentId) });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const establishmentId = demoEstablishmentId();
  if (!establishmentId) return NextResponse.json({ error: "INTERNAL_CONFIGURATION_ERROR" }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const action = body.action;
  try {
    if (action === "provision") {
      const catalog = await seedDemoCatalog(establishmentId);
      const scenario = await resetDemoScenario(establishmentId);
      return NextResponse.json({ establishmentId, catalog, scenario }, { status: 200 });
    }

    if (action === "reset_scenario") {
      return NextResponse.json({ establishmentId, scenario: await resetDemoScenario(establishmentId) }, { status: 200 });
    }

    if (action === "reset_session") {
      const leadId = body.leadId;
      if (typeof leadId !== "string" || !leadId.trim()) {
        return NextResponse.json({ error: "INVALID_PAYLOAD", details: "leadId obrigatório" }, { status: 400 });
      }
      return NextResponse.json({ establishmentId, leadId, removed: await cleanupDemoSession(establishmentId, leadId) }, { status: 200 });
    }

    if (action === "cleanup_expired") {
      const leads = await listExpiredDemoLeads(establishmentId);
      const removed = [];
      for (const leadId of leads) {
        removed.push({ leadId, ...(await cleanupDemoSession(establishmentId, leadId)) });
      }
      return NextResponse.json({ establishmentId, expiredLeads: leads.length, removed }, { status: 200 });
    }

    return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
  } catch (error) {
    console.error("[internal/demo-environment] falha", {
      action: typeof action === "string" ? action : "unknown",
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
