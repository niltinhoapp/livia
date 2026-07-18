// Cron: lembrete anti-no-show.
// Para cada estabelecimento com WhatsApp conectado e template de lembrete
// configurado, envia um lembrete dos agendamentos que começam nas próximas
// ~24h e ainda não receberam lembrete. O envio é por TEMPLATE (fora da janela
// de 24h a Meta exige HSM aprovado).
//
// Roda 1x/dia (limite do plano Hobby da Vercel; no Pro dá pra aumentar a
// frequencia). Protegido pelo CRON_SECRET.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase/admin";
import { getScheduleConfig, listAppointments, updateAppointment } from "@/lib/scheduling";
import { sendTemplate } from "@/lib/whatsapp/client";
import type { Establishment } from "@/types";

const WINDOW_MS = 24 * 3600000; // avisa quem começa nas próximas 24h

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }

  const now = Date.now();
  const snap = await db
    .collection("establishments")
    .where("whatsapp.status", "==", "connected")
    .get();

  let sent = 0;
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const doc of snap.docs) {
    const est = doc.data() as Establishment;
    if (!est.whatsapp) continue;

    const config = await getScheduleConfig(est.id);
    if (!config.reminderTemplateName) {
      skipped.push(`${est.id}: sem template de lembrete configurado`);
      continue;
    }

    const appts = await listAppointments(est.id, now, now + WINDOW_MS);
    for (const a of appts) {
      if (a.reminderSentAt) continue;
      if (a.status !== "pending" && a.status !== "confirmed") continue;
      try {
        const whenLocal = formatLocal(a.startAt, config.utcOffsetMinutes);
        await sendTemplate(
          est.whatsapp,
          a.contactPhone,
          config.reminderTemplateName,
          config.reminderTemplateLang,
          // {{1}} nome do cliente, {{2}} serviço, {{3}} data/hora
          [a.contactName ?? "tudo bem?", a.serviceName, whenLocal],
        );
        await updateAppointment(est.id, a.id, { reminderSentAt: now });
        sent++;
      } catch (err) {
        errors.push(`${est.id}/${a.id}: ${String(err)}`);
        console.error(`[reminders] falha ${est.id}/${a.id}:`, err);
      }
    }
  }

  return NextResponse.json({ establishments: snap.size, sent, skipped, errors });
}

// epoch -> "DD/MM às HH:MM" no fuso local (offset fixo).
function formatLocal(epoch: number, offsetMin: number): string {
  const d = new Date(epoch + offsetMin * 60000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm} às ${hh}:${mi}`;
}
