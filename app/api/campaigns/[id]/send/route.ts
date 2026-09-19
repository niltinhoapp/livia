import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { campaignsMaxRecipientsPerCampaign, campaignsSendEnabled } from "@/lib/campaignConfig";
import { activateCampaign, getCampaign, getEstablishment } from "@/lib/repo";
import { dispatchCampaignBatch } from "@/lib/campaignDispatcher";
import { listMessageTemplates, WhatsAppTemplateError } from "@/lib/whatsapp/client";
import { isCampaignTemplateCompatible, matchesCampaignTemplate } from "@/lib/campaignTemplates";

export const dynamic = "force-dynamic";

function errorStatus(reason: string): number {
  if (reason === "campaign_not_found") return 404;
  if (reason === "recipient_limit_exceeded") return 409;
  if (reason === "scheduled_at_must_be_future") return 400;
  return 400;
}

/** Ativa e processa apenas um lote limitado pelo dispatcher oficial. */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  if (!campaignsSendEnabled()) {
    return NextResponse.json({ error: "envio de campanhas desabilitado por configuração operacional" }, { status: 503 });
  }

  const establishment = await getEstablishment(establishmentId);
  if (!establishment?.whatsapp || establishment.whatsapp.status !== "connected") {
    return NextResponse.json({ error: "WhatsApp não está conectado" }, { status: 409 });
  }

  let body: { confirm?: unknown; scheduledAt?: unknown } = {};
  try { body = (await req.json()) as typeof body; } catch { /* corpo vazio tratado abaixo */ }
  if (body.confirm !== true) return NextResponse.json({ error: "confirmação explícita obrigatória" }, { status: 400 });

  const { id } = await context.params;
  const draft = await getCampaign(establishmentId, id);
  if (!draft) return NextResponse.json({ error: "campanha não encontrada" }, { status: 404 });
  if (!draft.template) return NextResponse.json({ error: "template da campanha não está preparado" }, { status: 400 });
  try {
    const templates = await listMessageTemplates(establishment.whatsapp, establishmentId);
    const current = templates.find((template) => matchesCampaignTemplate(draft.template!, template));
    if (!current || !isCampaignTemplateCompatible(current)) {
      return NextResponse.json({ error: "template não está aprovado ou não é compatível com este envio" }, { status: 409 });
    }
  } catch (error) {
    if (error instanceof WhatsAppTemplateError) return NextResponse.json({ error: "não foi possível revalidar o template" }, { status: 502 });
    console.error("[campaigns/send] revalidação de template falhou", { establishmentId, campaignId: id });
    return NextResponse.json({ error: "não foi possível revalidar o template" }, { status: 502 });
  }
  const scheduledAt = body.scheduledAt === undefined || body.scheduledAt === null ? null : Number(body.scheduledAt);
  if (scheduledAt !== null && !Number.isFinite(scheduledAt)) {
    return NextResponse.json({ error: "data de agendamento inválida" }, { status: 400 });
  }

  const result = await activateCampaign(establishmentId, id, {
    mode: scheduledAt === null ? "now" : "scheduled",
    scheduledAt,
    maxRecipients: campaignsMaxRecipientsPerCampaign(),
  });
  if (result.kind === "invalid") return NextResponse.json({ error: result.reason }, { status: errorStatus(result.reason) });
  // Lote limitado: o endpoint nunca percorre uma campanha grande. O claim
  // persistente do dispatcher permite concorrência/retry sem duplicar envio.
  const dispatch = result.campaign.status === "running"
    ? await dispatchCampaignBatch(establishmentId, id, { batchSize: campaignsMaxRecipientsPerCampaign() })
    : null;
  const campaign = await getCampaign(establishmentId, id) ?? result.campaign;
  return NextResponse.json({ campaign, activated: result.kind === "activated", idempotent: result.kind === "already_activated", dispatch }, { status: 200 });
}
