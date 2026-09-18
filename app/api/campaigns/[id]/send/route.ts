import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { campaignsMaxRecipientsPerCampaign, campaignsSendEnabled } from "@/lib/campaignConfig";
import { activateCampaign } from "@/lib/repo";
import { getEstablishment } from "@/lib/repo";

export const dynamic = "force-dynamic";

function errorStatus(reason: string): number {
  if (reason === "campaign_not_found") return 404;
  if (reason === "recipient_limit_exceeded") return 409;
  if (reason === "scheduled_at_must_be_future") return 400;
  return 400;
}

/** Apenas arma a campanha; o envio continua sendo responsabilidade do cron/dispatcher. */
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
  const scheduledAt = body.scheduledAt === undefined || body.scheduledAt === null ? null : Number(body.scheduledAt);
  if (scheduledAt !== null && !Number.isFinite(scheduledAt)) {
    return NextResponse.json({ error: "data de agendamento inválida" }, { status: 400 });
  }

  const result = await activateCampaign(establishmentId, id, {
    mode: scheduledAt === null ? "now" : "scheduled",
    scheduledAt,
    maxRecipients: campaignsMaxRecipientsPerCampaign(),
  });
  if (result.kind === "already_activated") return NextResponse.json({ campaign: result.campaign, idempotent: true });
  if (result.kind === "invalid") return NextResponse.json({ error: result.reason }, { status: errorStatus(result.reason) });
  return NextResponse.json({ campaign: result.campaign, activated: true }, { status: 200 });
}
