// GET /api/human-handoff/settings -> configuração do aviso + dispositivos com push
// PUT /api/human-handoff/settings -> { push, whatsapp, responsiblePhone, templateName, templateLang }
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment } from "@/lib/repo";
import { countPushDevices } from "@/lib/humanHandoff/push";
import { saveHandoffSettings } from "@/lib/humanHandoff/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const establishment = await getEstablishment(establishmentId);
  if (!establishment) return NextResponse.json({ error: "estabelecimento não encontrado" }, { status: 404 });
  return NextResponse.json({
    config: establishment.humanHandoffNotifications ?? null,
    pushDevices: await countPushDevices(establishmentId),
    whatsappConnected: establishment.whatsapp?.status === "connected",
  });
}

export async function PUT(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const establishment = await getEstablishment(establishmentId);
  if (!establishment) return NextResponse.json({ error: "estabelecimento não encontrado" }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "payload inválido" }, { status: 400 });
  const result = await saveHandoffSettings(establishment, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ config: result.config });
}
