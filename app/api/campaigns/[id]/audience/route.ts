import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment, prepareCampaignAudience } from "@/lib/repo";
import { campaignTemplateSnapshot, isCampaignTemplateCompatible } from "@/lib/campaignTemplates";
import { listMessageTemplates, WhatsAppTemplateError } from "@/lib/whatsapp/client";

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
    const requestedTemplate = body.template as { id?: unknown; name?: unknown; languageCode?: unknown } | undefined;
    if (!requestedTemplate || typeof requestedTemplate.id !== "string" || typeof requestedTemplate.name !== "string" || typeof requestedTemplate.languageCode !== "string") {
      return NextResponse.json({ error: "template inválido" }, { status: 400 });
    }
    const establishment = await getEstablishment(establishmentId);
    if (!establishment?.whatsapp || establishment.whatsapp.status !== "connected") {
      return NextResponse.json({ error: "WhatsApp não está conectado" }, { status: 409 });
    }
    const templates = await listMessageTemplates(establishment.whatsapp, establishmentId);
    const template = templates.find((item) => item.id === requestedTemplate.id && item.name === requestedTemplate.name && item.language === requestedTemplate.languageCode);
    if (!template || !isCampaignTemplateCompatible(template)) {
      return NextResponse.json({ error: "template não está aprovado ou não é compatível com este envio" }, { status: 409 });
    }
    const result = await prepareCampaignAudience(establishmentId, campaignId, {
      selection: body.selection,
      phones: Array.isArray(body.phones) ? body.phones.filter((phone): phone is string => typeof phone === "string") : undefined,
      template: campaignTemplateSnapshot(template),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WhatsAppTemplateError) return NextResponse.json({ error: "não foi possível revalidar o template" }, { status: 502 });
    return NextResponse.json({ error: "não foi possível preparar a audiência" }, { status: 400 });
  }
}
