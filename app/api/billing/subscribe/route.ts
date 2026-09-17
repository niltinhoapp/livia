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
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment, linkEstablishmentBilling } from "@/lib/repo";
import { resolveOrCreateAsaasCustomer } from "@/lib/billing/customerIdentity";
import { provisionAsaasSubscription } from "@/lib/billing/provisioning";
import { resolvePixPaymentForSubscription } from "@/lib/billing/pixPayment";
import { createAsaasClient, type AsaasClient, type AsaasEnvironment } from "@/lib/billing/asaas";

const PLAN_VALUE = 129;
const PLAN_CYCLE = "MONTHLY" as const;
const PLAN_BILLING_TYPE = "PIX" as const;

// Única geração de assinatura suportada nesta OT: o produto ainda não tem
// fluxo de "nova assinatura após cancelamento" (que exigiria bump de
// generation — fora de escopo). provisionAsaasSubscription é idempotente
// por establishmentId+generation: chamadas repetidas convergem para a
// mesma intent, nunca duplicam customer nem subscription.
const SUBSCRIPTION_GENERATION = 1;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

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

  const result = await provisionAsaasSubscription(
    {
      establishmentId,
      subscriptionGeneration: SUBSCRIPTION_GENERATION,
      asaasCustomerId: customerResult.externalCustomerId,
      leaseOwner: "billing-subscribe-endpoint",
      billingType: PLAN_BILLING_TYPE,
      value: PLAN_VALUE,
      cycle: PLAN_CYCLE,
      nextDueDate: todayIsoDate(),
    },
    { asaas, now: Date.now, newId: randomUUID },
  );

  if (result.ok && result.phase === "succeeded" && result.intent.externalSubscriptionId) {
    const externalSubscriptionId = result.intent.externalSubscriptionId;
    await linkEstablishmentBilling(establishmentId, { externalSubscriptionId });

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

  return NextResponse.json({ error: "SUBSCRIPTION_PROVISIONING_FAILED" }, { status: 502 });
}
