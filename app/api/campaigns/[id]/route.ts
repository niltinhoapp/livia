import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { deleteDraftCampaign, getCampaign, listCampaignRecipients } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const { id } = await context.params;
  const campaign = await getCampaign(establishmentId, id);
  if (!campaign) return NextResponse.json({ error: "campanha não encontrada" }, { status: 404 });
  const recipients = await listCampaignRecipients(establishmentId, id);
  return NextResponse.json({ campaign, recipients });
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const { id } = await context.params;
  const deleted = await deleteDraftCampaign(establishmentId, id);
  return deleted
    ? NextResponse.json({ deleted: true })
    : NextResponse.json({ error: "somente rascunhos podem ser removidos" }, { status: 409 });
}
