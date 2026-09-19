// POST /api/billing/subscribe — inicia a assinatura real da Lívia para o
// establishment autenticado (OT-07E1) e devolve a cobrança PIX pronta para
// pagamento (OT-07E2). Conecta o customer/subscription Asaas já homologados
// (OT-05H/OT-06/OT-07E0) ao fluxo real de produto — até OT-07E1 só o
// harness administrativo os exercitava.
//
// Plano fixo do MVP (nunca aceito do cliente): R$129/mês, MONTHLY, PIX.
// establishmentId nunca vem do corpo da requisição — sempre resolvido pela
// sessão autenticada (mesmo padrão de app/api/establishment).
//
// FONTE DE VERDADE: esta rota NUNCA marca billingStatus como "active" —
// devolver o QR/copia-e-cola só dá ao cliente uma forma de pagar, não prova
// pagamento. Só o webhook (app/api/webhooks/asaas/route.ts, já homologado)
// aplica essa transição.
//
// RECONTRATAÇÃO/RETOMADA (OT de correção do provisionamento): a geração e o
// nextDueDate usados NUNCA são fixos/recalculados às cegas — ver
// resolveTargetGeneration/resolveNextDueDate abaixo. Isso é o que permite
// retomar a MESMA tentativa em outro dia sem identity_conflict, e recontratar
// de verdade depois de "canceled" sem travar contra uma subscription morta.
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment, linkEstablishmentBilling } from "@/lib/repo";
import { resolveOrCreateAsaasCustomer } from "@/lib/billing/customerIdentity";
import { provisionAsaasSubscription, getBillingProvisioningIntent } from "@/lib/billing/provisioning";
import { resolvePixPaymentForSubscription } from "@/lib/billing/pixPayment";
import { createAsaasClient, type AsaasClient, type AsaasEnvironment } from "@/lib/billing/asaas";
import { resolveTargetGeneration } from "@/lib/billing/generation";
import { isTrialPaymentBlocked } from "@/lib/billing/trialWindow";

const PLAN_VALUE = 129;
const PLAN_CYCLE = "MONTHLY" as const;
const PLAN_BILLING_TYPE = "PIX" as const;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// nextDueDate É PARTE do fingerprint que identifica uma tentativa
// (subscriptionFingerprint, lib/billing/provisioning.ts) — recalculá-lo a
// cada chamada faz qualquer retomada em outro dia calendário virar
// identity_conflict, mesmo sendo a MESMA tentativa. Resolve isto lendo o
// intent já existente para (establishmentId, generation): se existe,
// reusa o nextDueDate ali gravado (não importa a fase — mesmo um intent
// "conflict" de uma geração ANTERIOR já foi abandonado por
// resolveTargetGeneration, nunca revisitado); só calcula hoje() quando
// esta é a primeira chamada desta geração.
async function resolveNextDueDate(establishmentId: string, generation: number): Promise<string> {
  const existing = await getBillingProvisioningIntent(establishmentId, generation);
  return existing?.terms.nextDueDate ?? todayIsoDate();
}

// Motivos de falha do provisionamento que uma retentativa imediata resolve
// sozinha (corrida de concorrência já resolvida no lado que venceu, ou
// instabilidade pontual da API da Asaas) — tratados como "processing", o
// mesmo 202 já usado para reserved/creating/reconciling. Qualquer outro
// motivo é estrutural: retry cego nunca resolve (ver SUBSCRIPTION_CONFLICT
// abaixo) — é exatamente a diferença que faltava (OT de recontratação):
// antes, TODO !result.ok virava um 502 genérico indistinguível de
// transitório.
const TRANSIENT_PROVISIONING_REASONS = new Set(["intent_changed", "lookup_failed"]);

// result.reason nunca é texto livre HOJE (só identificadores curtos que
// provisionAsaasSubscription produz) — mas esta rota não confia cegamente
// nisso: só ecoa pro cliente um motivo que está nesta allowlist explícita.
// Qualquer coisa fora dela (inclusive um "reason" corrompido/inesperado)
// vira "unknown" — nunca risco de a resposta carregar algo que não devia
// (mesmo espírito de sanitizedError() em provisioning.ts, nunca confiar que
// um campo de erro é seguro por default).
const KNOWN_CONFLICT_REASONS = new Set([
  "identity_conflict",
  "known_subscription_unavailable",
  "known_subscription_mismatch",
  "known_subscription_inactive",
  "multiple_subscriptions",
  "subscription_mismatch",
  "subscription_inactive",
  "created_subscription_mismatch",
  "asaas_rejected",
]);

function createBillingSubscribeAsaasClient(): AsaasClient {
  const apiKey = process.env.ASAAS_API_KEY;
  const environment = process.env.ASAAS_ENVIRONMENT;
  if (!apiKey || (environment !== "sandbox" && environment !== "production")) {
    throw new Error("ASAAS_API_KEY/ASAAS_ENVIRONMENT ausentes ou inválidos.");
  }
  return createAsaasClient({ environment: environment as AsaasEnvironment, apiKey });
}

export async function POST(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const establishment = await getEstablishment(establishmentId);
  if (!establishment) {
    return NextResponse.json({ error: "ESTABLISHMENT_NOT_FOUND" }, { status: 404 });
  }

  // Assinatura já ativa (aplicado pelo webhook): nenhuma nova contratação,
  // nenhum CPF/CNPJ necessário de novo. Idempotente por construção — nem
  // toca customer/subscription/Asaas.
  if (establishment.billing?.billingStatus === "active") {
    return NextResponse.json({ status: "active" });
  }

  // Regra definitiva do trial (auditoria pré-primeiro-pagamento real):
  // nenhuma cobrança pode nascer antes de trialEndsAt-24h — nem PIX, nem
  // cartão. Backend é autoridade: bloqueado aqui ANTES de ler o corpo da
  // requisição ou tocar qualquer credencial/cliente Asaas, então mesmo uma
  // chamada direta à API (sem passar pela UI) nunca consegue criar uma
  // cobrança antecipada. A partir de trialEndsAt-24h (inclusive) a rota
  // funciona normalmente, sem nenhuma outra mudança de comportamento.
  if (isTrialPaymentBlocked(establishment.billing, Date.now())) {
    return NextResponse.json({ error: "TRIAL_PAYMENT_NOT_YET_AVAILABLE" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const cpfCnpj = (body as { cpfCnpj?: unknown } | null)?.cpfCnpj;
  if (typeof cpfCnpj !== "string" || cpfCnpj.trim() === "") {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }

  let asaas: AsaasClient;
  try {
    asaas = createBillingSubscribeAsaasClient();
  } catch {
    return NextResponse.json({ error: "BILLING_UNAVAILABLE" }, { status: 503 });
  }

  const customerResult = await resolveOrCreateAsaasCustomer(
    { asaas },
    { establishmentId, name: establishment.name, cpfCnpj },
  );
  if (!customerResult.ok) {
    const status = customerResult.reason === "invalid_cpf_cnpj" ? 400 : 502;
    return NextResponse.json({ error: "CUSTOMER_RESOLUTION_FAILED" }, { status });
  }

  await linkEstablishmentBilling(establishmentId, { externalCustomerId: customerResult.externalCustomerId });

  // Recalculados a cada chamada a partir do que já está persistido — nunca
  // incrementados/salvos antecipadamente. Isso é o que faz retentativas
  // sucessivas (mesmo dia, dia seguinte, ou várias tentativas de
  // recontratação antes de uma finalmente suceder) convergirem
  // consistentemente para a MESMA geração-alvo e o MESMO nextDueDate, sem
  // nenhuma coordenação extra além do que já está gravado no Firestore.
  const subscriptionGeneration = resolveTargetGeneration(establishment.billing);
  const nextDueDate = await resolveNextDueDate(establishmentId, subscriptionGeneration);

  const result = await provisionAsaasSubscription(
    {
      establishmentId,
      subscriptionGeneration,
      asaasCustomerId: customerResult.externalCustomerId,
      leaseOwner: "billing-subscribe-endpoint",
      billingType: PLAN_BILLING_TYPE,
      value: PLAN_VALUE,
      cycle: PLAN_CYCLE,
      nextDueDate,
    },
    { asaas, now: Date.now, newId: randomUUID },
  );

  if (result.ok && result.phase === "succeeded" && result.intent.externalSubscriptionId) {
    const externalSubscriptionId = result.intent.externalSubscriptionId;
    await linkEstablishmentBilling(establishmentId, { externalSubscriptionId, subscriptionGeneration });

    // subscriptionId vem exclusivamente do intent que o PRÓPRIO backend
    // acabou de provisionar/reconciliar para este establishment — nunca do
    // corpo da requisição. Isso é o que garante que um tenant nunca possa
    // consultar a cobrança de outro.
    const pix = await resolvePixPaymentForSubscription(
      { asaas },
      { subscriptionId: externalSubscriptionId, nextDueDate: result.intent.terms.nextDueDate },
    );
    if (pix.ok && pix.status === "ready") {
      return NextResponse.json({
        status: "payment_required",
        payment: {
          pixCopyPaste: pix.pixCopyPaste,
          qrCode: pix.qrCode,
          ...(pix.expiresAt !== undefined ? { expiresAt: pix.expiresAt } : {}),
        },
      });
    }
    if (pix.ok) {
      // not_generated_yet: corrida logo após criar a subscription — retry
      // seguro (idempotente) do mesmo endpoint resolve.
      return NextResponse.json({ status: "processing" }, { status: 202 });
    }
    return NextResponse.json({ error: "PIX_LOOKUP_FAILED" }, { status: 502 });
  }

  if (result.ok) {
    // reserved/creating/reconciling: em andamento, sem falha definitiva —
    // a mesma chamada pode ser repetida com segurança (idempotente).
    return NextResponse.json({ status: "processing" }, { status: 202 });
  }

  // result.reason já vem de provisionAsaasSubscription — nunca texto livre,
  // nunca payload da Asaas. Transitório (corrida resolvida do outro lado,
  // instabilidade pontual) vira o mesmo 202 já usado acima; qualquer outro
  // motivo é estrutural — retry cego nunca resolve sozinho, então NUNCA mais
  // 502 genérico ("tente novamente" seria enganoso). 409 sinaliza ao front
  // que a saída certa é regularizar/falar com o suporte, não tentar de novo.
  if (TRANSIENT_PROVISIONING_REASONS.has(result.reason)) {
    return NextResponse.json({ status: "processing" }, { status: 202 });
  }
  const reason = KNOWN_CONFLICT_REASONS.has(result.reason) ? result.reason : "unknown";
  return NextResponse.json({ error: "SUBSCRIPTION_CONFLICT", reason }, { status: 409 });
}
