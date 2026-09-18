import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { prepareCampaignAudience } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const { id: campaignId } = await context.params;
  try {
    const body = (await req.json()) as { selection?: unknown; phones?: unknown; template?: unknown };
    if (body.selection !== "all_eligible" && body.selection !== "selected") {
      return NextResponse.json({ error: "seleção inválida" }, { status: 400 });
    }
    const result = await prepareCampaignAudience(establishmentId, campaignId, {
      selection: body.selection,
      phones: Array.isArray(body.phones) ? body.phones.filter((phone): phone is string => typeof phone === "string") : undefined,
      template: body.template as never,
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "não foi possível preparar a audiência" }, { status: 400 });
  }
}
