// POST /api/billing/checkout — inicia a contratação real da Lívia via
// Hosted Checkout do Asaas (cartão de crédito), irmão de
// app/api/billing/subscribe/route.ts (PIX direto, intocado — os dois
// caminhos coexistem, cada um com sua própria autoridade de criação).
//
// establishmentId nunca vem do corpo da requisição — sempre resolvido pela
// sessão autenticada (mesmo padrão de subscribe/route.ts).
//
// FONTE DE VERDADE: esta rota NUNCA marca billingStatus como "active" —
// devolver a URL do Checkout só dá ao cliente uma forma de pagar, não prova
// pagamento. Só o webhook (app/api/webhooks/asaas/route.ts) aplica essa
// transição, e só depois de correlacionar o evento pelo vínculo
// checkoutId -> establishment que esta rota persiste (ver
// lib/billing/checkoutProvisioning.ts).
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment } from "@/lib/repo";
import { provisionBillingCheckout, getBillingCheckoutIntent } from "@/lib/billing/checkoutProvisioning";
import { createAsaasClient, type AsaasClient, type AsaasEnvironment } from "@/lib/billing/asaas";
import { resolveTargetGeneration } from "@/lib/billing/generation";
import { isTrialPaymentBlocked } from "@/lib/billing/trialWindow";

const PLAN_VALUE = 129;
const PLAN_CYCLE = "MONTHLY" as const;
const CHECKOUT_MINUTES_TO_EXPIRE = 60;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Mesmo raciocínio de resolveNextDueDate em subscribe/route.ts: nextDueDate
// é parte do fingerprint que identifica a tentativa (checkoutFingerprint,
// lib/billing/checkoutProvisioning.ts) — recalculá-lo a cada chamada faria
// qualquer retomada em outro dia calendário criar uma tentativa "nova" ao
// invés de reaproveitar/expirar a existente. Reusa o nextDueDate já
// persistido para esta geração quando existe; só calcula hoje() na
// primeira chamada.
async function resolveNextDueDate(establishmentId: string, generation: number): Promise<string> {
  const existing = await getBillingCheckoutIntent(establishmentId, generation);
  return existing?.terms.nextDueDate ?? todayIsoDate();
}

function createBillingCheckoutAsaasClient(): AsaasClient {
  const apiKey = process.env.ASAAS_API_KEY;
  const environment = process.env.ASAAS_ENVIRONMENT;
  if (!apiKey || (environment !== "sandbox" && environment !== "production")) {
    throw new Error("ASAAS_API_KEY/ASAAS_ENVIRONMENT ausentes ou inválidos.");
  }
  return createAsaasClient({ environment: environment as AsaasEnvironment, apiKey });
}

// Mesmo espírito de KNOWN_CONFLICT_REASONS em subscribe/route.ts: nunca
// ecoa um "reason" que não esteja nesta allowlist.
const KNOWN_CONFLICT_REASONS = new Set(["identity_conflict", "asaas_rejected"]);

export async function POST(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const establishment = await getEstablishment(establishmentId);
  if (!establishment) {
    return NextResponse.json({ error: "ESTABLISHMENT_NOT_FOUND" }, { status: 404 });
  }

  // Idêntico ao guard de subscribe/route.ts: assinatura já ativa (aplicada
  // pelo webhook) -> nenhuma nova tentativa, idempotente por construção.
  if (establishment.billing?.billingStatus === "active") {
    return NextResponse.json({ status: "active" });
  }

  // MESMO gate de subscribe/route.ts (lib/billing/trialWindow.ts,
  // compartilhado) — nenhum Checkout pode nascer antes de trialEndsAt-24h,
  // nem por chamada direta à API. Bloqueado ANTES de tocar qualquer
  // credencial/cliente Asaas.
  if (isTrialPaymentBlocked(establishment.billing, Date.now())) {
    return NextResponse.json({ error: "TRIAL_PAYMENT_NOT_YET_AVAILABLE" }, { status: 403 });
  }

  let asaas: AsaasClient;
  try {
    asaas = createBillingCheckoutAsaasClient();
  } catch {
    return NextResponse.json({ error: "BILLING_UNAVAILABLE" }, { status: 503 });
  }

  // MESMA regra de geração do fluxo PIX (lib/billing/generation.ts,
  // compartilhada) — os dois caminhos de pagamento nunca podem divergir em
  // qual geração está "em jogo" para este establishment.
  const subscriptionGeneration = resolveTargetGeneration(establishment.billing);
  const nextDueDate = await resolveNextDueDate(establishmentId, subscriptionGeneration);

  // req.nextUrl.origin reflete o host real da requisição (produção,
  // preview ou local) — nunca hardcoded, nunca uma env var separada que
  // poderia divergir do domínio real servindo esta rota.
  const returnBase = `${req.nextUrl.origin}/painel/plano`;

  const result = await provisionBillingCheckout(
    {
      establishmentId,
      subscriptionGeneration,
      leaseOwner: "billing-checkout-endpoint",
      value: PLAN_VALUE,
      cycle: PLAN_CYCLE,
      nextDueDate,
      successUrl: `${returnBase}?checkout=success`,
      cancelUrl: `${returnBase}?checkout=cancel`,
      expiredUrl: `${returnBase}?checkout=expired`,
      minutesToExpire: CHECKOUT_MINUTES_TO_EXPIRE,
    },
    { asaas, now: Date.now, newId: randomUUID },
  );

  if (result.ok && result.phase === "created") {
    // checkoutUrl vem exclusivamente do que o PRÓPRIO backend acabou de
    // provisionar/reaproveitar para este establishment — nunca de entrada
    // do cliente. O vínculo checkoutId -> establishment já está persistido
    // (dentro de provisionBillingCheckout, atomicamente com o intent) antes
    // desta resposta existir.
    return NextResponse.json({ status: "checkout_created", checkoutUrl: result.intent.checkoutLink });
  }

  if (result.ok) {
    // "busy": outra requisição concorrente (duplo clique, duas abas) está
    // criando o Checkout agora — repetir a MESMA chamada é seguro.
    return NextResponse.json({ status: "processing" }, { status: 202 });
  }

  // "conflict"/"failed_terminal": identity_conflict ou rejeição conclusiva
  // da Asaas — nunca 502 genérico (mesma disciplina de subscribe/route.ts).
  // result.reason já vem de provisionBillingCheckout, nunca texto livre;
  // ainda assim só ecoa um motivo desta allowlist explícita.
  const reason = KNOWN_CONFLICT_REASONS.has(result.reason) ? result.reason : "unknown";
  return NextResponse.json({ error: "CHECKOUT_CONFLICT", reason }, { status: 409 });
}
