// Geração-alvo de uma tentativa de contratação — compartilhado entre os dois
// caminhos de pagamento (PIX direto em app/api/billing/subscribe/route.ts e
// Hosted Checkout em app/api/billing/checkout/route.ts). Extraído para cá na
// migração para Hosted Checkout (cartão) para que os dois caminhos NUNCA
// possam divergir na mesma regra — duplicar esta lógica arriscaria os dois
// meios de pagamento calcularem gerações diferentes para o mesmo
// establishment.
import type { EstablishmentBilling } from "@/types";

// Ausência de subscriptionGeneration = geração 1 (todo establishment
// provisionado antes deste campo existir). Só avança quando billingStatus já
// é "canceled": a state machine nunca reativa canceled por payment_confirmed
// (é deliberado, ver stateMachine.ts), então reusar a MESMA geração de uma
// assinatura cancelada travaria para sempre em known_subscription_inactive/
// subscription_inactive (PIX) ou nunca correlacionaria (Checkout). Para
// qualquer outro status (trial/past_due/suspended), a geração atual é
// reaproveitada — é assim que uma retomada normal da mesma tentativa não
// vira recontratação.
export function resolveTargetGeneration(billing: EstablishmentBilling | undefined): number {
  const currentGeneration = billing?.subscriptionGeneration ?? 1;
  return billing?.billingStatus === "canceled" ? currentGeneration + 1 : currentGeneration;
}
