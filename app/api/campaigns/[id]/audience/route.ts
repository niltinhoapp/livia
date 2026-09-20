import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { countTrialCampaignRecipients, getEstablishment, prepareCampaignAudience } from "@/lib/repo";
import { campaignTemplateSnapshot, isCampaignTemplateCompatible, templateParameterBindingsAreValid } from "@/lib/campaignTemplates";
import { listMessageTemplates, WhatsAppTemplateError } from "@/lib/whatsapp/client";
import type { CampaignTemplateParameterBinding } from "@/types";

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
    const requestedTemplate = body.template as { id?: unknown; name?: unknown; languageCode?: unknown; parameterBindings?: unknown } | undefined;
    if (!requestedTemplate || typeof requestedTemplate.id !== "string" || typeof requestedTemplate.name !== "string" || typeof requestedTemplate.languageCode !== "string") {
      return NextResponse.json({ error: "template inválido" }, { status: 400 });
    }
    const establishment = await getEstablishment(establishmentId);
    if (!establishment?.whatsapp || establishment.whatsapp.status !== "connected") {
      return NextResponse.json({ error: "WhatsApp não está conectado" }, { status: 409 });
    }
    if (establishment.billing?.billingStatus === "trial") {
      const used = await countTrialCampaignRecipients(establishmentId);
      const remaining = Math.max(0, 100 - used);
      const requestedCount = body.selection === "selected" && Array.isArray(body.phones)
        ? new Set(body.phones.filter((phone): phone is string => typeof phone === "string")).size
        : undefined;
      if (remaining < 1 || (requestedCount !== undefined && requestedCount > remaining)) {
        return NextResponse.json({ error: "limite_total_trial_excedido", limit: 100, used, remaining }, { status: 409 });
      }
    }
    const templates = await listMessageTemplates(establishment.whatsapp, establishmentId);
    const template = templates.find((item) => item.id === requestedTemplate.id && item.name === requestedTemplate.name && item.language === requestedTemplate.languageCode);
    if (!template || !isCampaignTemplateCompatible(template)) {
      return NextResponse.json({ error: "template não está aprovado ou não é compatível com este envio" }, { status: 409 });
    }
    const parameterBindings = Array.isArray(requestedTemplate.parameterBindings)
      ? requestedTemplate.parameterBindings as CampaignTemplateParameterBinding[]
      : undefined;
    if (!templateParameterBindingsAreValid(template.components, parameterBindings)) {
      return NextResponse.json({ error: "preencha todas as variáveis do template" }, { status: 400 });
    }
    const result = await prepareCampaignAudience(establishmentId, campaignId, {
      selection: body.selection,
      phones: Array.isArray(body.phones) ? body.phones.filter((phone): phone is string => typeof phone === "string") : undefined,
      template: campaignTemplateSnapshot(template, parameterBindings),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WhatsAppTemplateError) return NextResponse.json({ error: "não foi possível revalidar o template" }, { status: 502 });
    return NextResponse.json({ error: "não foi possível preparar a audiência" }, { status: 400 });
  }
}
