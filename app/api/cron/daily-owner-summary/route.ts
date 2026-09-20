import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase/admin";
import { getDashboardMetrics } from "@/lib/dashboard";
import { getScheduleConfig } from "@/lib/scheduling";
import { markDailyOwnerSummarySent } from "@/lib/repo";
import { sendTemplate } from "@/lib/whatsapp/client";
import type { Establishment } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  const snap = await db.collection("establishments").where("whatsapp.status", "==", "connected").get();
  const now = Date.now(); let sent = 0, skipped = 0; const errors: string[] = [];
  for (const doc of snap.docs) {
    const est = doc.data() as Establishment; const cfg = est.dailyOwnerSummary;
    if (!est.whatsapp || !cfg?.enabled || !cfg.ownerPhone || !cfg.templateName) { skipped++; continue; }
    try {
      const schedule = await getScheduleConfig(est.id);
      const local = new Date(now + schedule.utcOffsetMinutes * 60000);
      const date = local.toISOString().slice(0, 10);
      const day = schedule.days[String(local.getUTCDay())];
      if (!day || cfg.lastSentDate === date) { skipped++; continue; }
      const [hh, mm] = day.close.split(":").map(Number);
      const closeMinute = hh * 60 + mm, currentMinute = local.getUTCHours() * 60 + local.getUTCMinutes();
      if (currentMinute < closeMinute || currentMinute > closeMinute + 90) { skipped++; continue; }
      const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - schedule.utcOffsetMinutes * 60000;
      const metrics = await getDashboardMetrics(est.id, start, now);
      await sendTemplate(est.whatsapp, est.id, cfg.ownerPhone, cfg.templateName, cfg.templateLang || "pt_BR", [
        est.name || "seu negócio", String(metrics.funnel.atendimentos), String(metrics.agendamentosCriadosHoje),
        String(metrics.oportunidadesAbertas), String(metrics.conversasPrecisandoHumano),
      ]);
      await markDailyOwnerSummarySent(est.id, date); sent++;
    } catch (error) { errors.push(`${est.id}: ${error instanceof Error ? error.message : "erro"}`); }
  }
  return NextResponse.json({ establishments: snap.size, sent, skipped, errors });
}
