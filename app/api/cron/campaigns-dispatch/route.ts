// Cron interno: dispatcher de Campanhas (CAMPANHAS-06).
// Processa um pequeno lote de recipients pendentes por campanha "running" a
// cada invocação — nunca a campanha inteira numa request só. Protegido pelo
// mesmo padrão de app/api/cron/reminders/route.ts (Bearer CRON_SECRET).
//
// NÃO adicionado a vercel.json crons nesta OT de propósito: até este PR ser
// revisado e mergeado deliberadamente, o endpoint existe mas não é chamado
// por ninguém em Production — nenhum disparo real acontece só por este
// código existir. Ver docs/CAMPANHAS.md, seção "Dispatcher", para o motivo e
// para como habilitar o agendamento depois.
//
// Aceita opcionalmente ?establishmentId=&campaignId= para rodar UMA
// campanha específica (uso de operação/reconciliação) — mesma autenticação,
// nunca exposto a usuário final.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase/admin";
import { dispatchCampaignBatch } from "@/lib/campaignDispatcher";
import { listCampaigns } from "@/lib/repo";
import { campaignsSendEnabled } from "@/lib/campaignConfig";
import type { Establishment } from "@/types";

export const dynamic = "force-dynamic";

const DEFAULT_BATCH_SIZE = 20;

export async function GET(req: NextRequest) {
  if (!campaignsSendEnabled()) {
    return NextResponse.json({ enabled: false, processed: 0, results: [], errors: [] });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }

  const targetEstablishmentId = req.nextUrl.searchParams.get("establishmentId");
  const targetCampaignId = req.nextUrl.searchParams.get("campaignId");

  const results: Array<{ establishmentId: string; campaignId: string } & Awaited<ReturnType<typeof dispatchCampaignBatch>>> = [];
  const errors: string[] = [];

  if (targetEstablishmentId && targetCampaignId) {
    try {
      const outcome = await dispatchCampaignBatch(targetEstablishmentId, targetCampaignId, { batchSize: DEFAULT_BATCH_SIZE });
      results.push({ establishmentId: targetEstablishmentId, campaignId: targetCampaignId, ...outcome });
    } catch (err) {
      errors.push(`${targetEstablishmentId}/${targetCampaignId}: ${String(err)}`);
      console.error("[campaigns-dispatch] falha na campanha alvo:", err);
    }
    return NextResponse.json({ processed: results.length, results, errors });
  }

  const snap = await db.collection("establishments").where("whatsapp.status", "==", "connected").get();

  for (const doc of snap.docs) {
    const est = doc.data() as Establishment;
    const campaigns = await listCampaigns(est.id);
    for (const campaign of campaigns) {
      if (campaign.status !== "running") continue;
      try {
        const outcome = await dispatchCampaignBatch(est.id, campaign.id, { batchSize: DEFAULT_BATCH_SIZE });
        results.push({ establishmentId: est.id, campaignId: campaign.id, ...outcome });
      } catch (err) {
        errors.push(`${est.id}/${campaign.id}: ${String(err)}`);
        console.error(`[campaigns-dispatch] falha ${est.id}/${campaign.id}:`, err);
      }
    }
  }

  return NextResponse.json({ processed: results.length, results, errors });
}
