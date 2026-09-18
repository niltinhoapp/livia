import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { createCampaign, listCampaigns } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  return NextResponse.json({ campaigns: await listCampaigns(establishmentId) });
}

export async function POST(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  try {
    const body = (await req.json()) as { name?: unknown };
    if (typeof body.name !== "string") return NextResponse.json({ error: "nome inválido" }, { status: 400 });
    return NextResponse.json({ campaign: await createCampaign(establishmentId, { name: body.name }) }, { status: 201 });
  } catch { return NextResponse.json({ error: "não foi possível criar a campanha" }, { status: 400 }); }
}
