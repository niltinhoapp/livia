// Cron: expiração de billing (trial/carência) — Fase 1 do gating de billing.
//
// Dois eixos que a state machine (lib/billing/stateMachine.ts) já define mas
// que, até aqui, nada disparava: um trial que passa de trialEndsAt sem
// nenhum sinal de cobrança, e uma carência (past_due) que passa de
// GRACE_PERIOD_MS sem regularizar. Este cron só decide QUANDO — a transição
// em si (e sua validade) fica inteiramente em lib/repo.ts::applyBillingStatusExpiry,
// que já é idempotente por construção (nextBillingStatus só aceita a
// transição a partir do estado exato; se o estabelecimento já regularizou
// entre a query abaixo e a chamada, ou já foi suspenso por uma execução
// anterior, a chamada é um no-op seguro).
//
// Só troca um campo no Firestore — nenhum envio de mensagem, nenhuma chamada
// à Meta/Asaas. Diferente de app/api/cron/campaigns-dispatch, é seguro
// deixar agendado no vercel.json (roda 1x/dia, mesmo limite do plano Hobby
// de app/api/cron/reminders).
//
// Protegido pelo mesmo CRON_SECRET dos demais crons.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase/admin";
import { applyBillingStatusExpiry } from "@/lib/repo";
import type { Establishment } from "@/types";

export const dynamic = "force-dynamic";

const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 dias de carência (past_due)

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }

  const now = Date.now();
  const results: { establishmentId: string; event: "trial_expired" | "grace_expired"; outcome: string }[] = [];
  const errors: string[] = [];

  // Duas queries de igualdade simples (sem índice composto novo) — mesma
  // filosofia já usada no resto do repo (ver lib/repo.ts::claimCampaignRecipients).
  const trialSnap = await db.collection("establishments").where("billing.billingStatus", "==", "trial").get();
  for (const doc of trialSnap.docs) {
    const est = doc.data() as Establishment;
    const trialEndsAt = est.billing?.trialEndsAt;
    if (typeof trialEndsAt !== "number" || !Number.isFinite(trialEndsAt) || trialEndsAt > now) continue;
    try {
      const outcome = await applyBillingStatusExpiry(est.id, "trial_expired", now);
      results.push({ establishmentId: est.id, event: "trial_expired", outcome });
    } catch (err) {
      errors.push(`${est.id}/trial_expired: ${String(err)}`);
      console.error(`[billing-expiry] falha trial_expired ${est.id}:`, err);
    }
  }

  const pastDueSnap = await db.collection("establishments").where("billing.billingStatus", "==", "past_due").get();
  for (const doc of pastDueSnap.docs) {
    const est = doc.data() as Establishment;
    const lastAsaasEventAt = est.billing?.lastAsaasEventAt;
    if (typeof lastAsaasEventAt !== "number" || !Number.isFinite(lastAsaasEventAt)) continue; // fail-safe: nunca suspende sem sinal confiável de quando a carência começou
    if (now - lastAsaasEventAt < GRACE_PERIOD_MS) continue;
    try {
      const outcome = await applyBillingStatusExpiry(est.id, "grace_expired", now);
      results.push({ establishmentId: est.id, event: "grace_expired", outcome });
    } catch (err) {
      errors.push(`${est.id}/grace_expired: ${String(err)}`);
      console.error(`[billing-expiry] falha grace_expired ${est.id}:`, err);
    }
  }

  return NextResponse.json({ processed: results.length, results, errors });
}
