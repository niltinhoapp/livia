// Localiza a cobrança PIX inicial de uma subscription recém-provisionada e
// obtém o QR Code correspondente (OT-07E2). Puramente leitura: nunca cria
// payment — a Asaas já gera a cobrança automaticamente ao criar/reconciliar
// a subscription; esta função só localiza a cobrança certa e busca o QR já
// existente.
//
// Isolamento de tenant: subscriptionId é sempre o valor já resolvido
// server-side (establishment.billing.externalSubscriptionId, nunca aceito
// do frontend — ver app/api/billing/subscribe/route.ts). A consulta em si
// já é escopada pela Asaas a essa subscription
// (GET /subscriptions/{id}/payments); nextDueDate desambigua qual cobrança
// dentro dela é a original desta contratação — mesma técnica de
// provisioning.ts (findOriginalPaymentEvidence, privada/não exportada,
// por isso reimplementada aqui em vez de importada).
import type { AsaasClient } from "./asaas";

export type ResolvePixPaymentDeps = {
  asaas: Pick<AsaasClient, "listSubscriptionPayments" | "getPixQrCode">;
};

export interface ResolvePixPaymentInput {
  subscriptionId: string;
  // Mesma data usada na CRIAÇÃO da subscription (vinda do intent persistido
  // em provisioning.ts — result.intent.terms.nextDueDate), nunca
  // recalculada aqui. Recalcular "hoje" a cada chamada quebraria a busca em
  // qualquer chamada repetida feita num dia diferente do da criação.
  nextDueDate: string;
}

export type ResolvePixPaymentResult =
  | { ok: true; status: "ready"; pixCopyPaste: string; qrCode: string; expiresAt?: string }
  // Corrida possível logo após criar a subscription: a Asaas ainda não
  // gerou o payment. Seguro pedir retry (mesma chamada, idempotente).
  | { ok: true; status: "not_generated_yet" }
  | { ok: false; reason: "ambiguous_payment" | "lookup_failed" | "qrcode_failed" };

export async function resolvePixPaymentForSubscription(
  deps: ResolvePixPaymentDeps,
  input: ResolvePixPaymentInput,
): Promise<ResolvePixPaymentResult> {
  const payments = await deps.asaas.listSubscriptionPayments(input.subscriptionId);
  if (!payments.ok) return { ok: false, reason: "lookup_failed" };

  const matches = payments.data.filter((p) => p.dueDate === input.nextDueDate);
  if (matches.length === 0) return { ok: true, status: "not_generated_yet" };
  // Nunca escolhe "a primeira" entre ambíguas — sem informação suficiente
  // para decidir com segurança qual pertence a esta contratação.
  if (matches.length > 1) return { ok: false, reason: "ambiguous_payment" };

  const payment = matches[0]!;
  const qr = await deps.asaas.getPixQrCode(payment.id);
  if (!qr.ok) return { ok: false, reason: "qrcode_failed" };

  return {
    ok: true,
    status: "ready",
    pixCopyPaste: qr.data.payload,
    qrCode: qr.data.encodedImage,
    ...(qr.data.expirationDate !== undefined ? { expiresAt: qr.data.expirationDate } : {}),
  };
}
