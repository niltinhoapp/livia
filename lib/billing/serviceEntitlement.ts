// F0.4 — ENTITLEMENT DE SERVIÇO NO SERVIDOR.
//
// O problema: `canUseService` (lib/billing/stateMachine.ts) existe, está
// correto e é testado — mas seu único consumidor era um hook React
// (components/hooks/useShellData.ts), que só produz um redirect no painel.
// O webhook do WhatsApp gateava apenas por `Establishment.status`, e NADA no
// código escreve `status: "suspended"` a partir do billing. Resultado: um
// tenant sem direito de uso continuava sendo atendido integralmente.
//
// ---- POR QUE NÃO É SÓ `if (!canUseService(...)) block` ----
//
// `canUseService` decide ACESSO AO PAINEL e falha FECHADO em dado
// malformado, o que é a escolha certa lá: na dúvida, o dono vê a tela de
// plano. No webhook a assimetria de custo é inversa — cortar o atendimento
// de um tenant que paga é pior do que atender por algumas horas um tenant
// que não paga. Dois casos são especialmente perigosos:
//
//   1. `billingStatus: "trial"` com `trialEndsAt` ausente/NaN. `canUseService`
//      bloqueia (fail-closed). Aqui NÃO bloqueamos: não há como PROVAR que o
//      trial terminou, e o cliente final do estabelecimento não tem nenhuma
//      relação com o SaaS.
//   2. `billingStatus` com um valor fora da união conhecida (corrupção,
//      migração parcial, escrita manual). O `switch` de `canUseService` não
//      casaria nenhum caso e devolveria `undefined` — que `!` transforma em
//      bloqueio. Aqui isso é classificado como estado não-provável.
//
// A regra deste módulo: **só bloqueia com motivo provável**. Ausência de
// billing (tenant legado/grandfathered) e estado não-provável sempre
// ATENDEM — mesma convenção de ausência-é-permitido já usada para
// panelAccess, whatsappBeta e ordersEnabled.
//
// ---- FRONTEIRA DE TEMPO ----
//
// A janela do trial vem de lib/billing/trialWindow.ts, a MESMA fonte que
// `canUseService` e as rotas de pagamento usam. O próprio trialWindow.ts
// documenta que essas fronteiras nunca podem divergir entre "posso cobrar?"
// e "o cliente ainda tem acesso?" — por isso este módulo não recalcula nada.
//
// Módulo puro: sem Firestore, sem process.env, sem Date.now() implícito.
// Não escreve `Establishment.status` nem `panelAccess`: `status` e
// `billing.billingStatus` seguem sendo eixos independentes, e este módulo só
// responde "pode operar agora?".
import type { Establishment } from "@/types";
import { resolveTrialPhase, trialAllowsAccess } from "./trialWindow";

export type ServiceEntitlementReason =
  // ---- atende ----
  | "no_billing_record" // tenant anterior à camada de billing (legado)
  | "trial_active" // trial dentro da janela (inclui final_day e grace)
  | "active" // assinatura em dia
  | "past_due" // carência: a cobrança está se resolvendo
  | "unprovable_billing_state" // dado malformado/desconhecido — nunca corta serviço
  // ---- bloqueia ----
  | "trial_expired"
  | "suspended"
  | "canceled";

export interface ServiceEntitlement {
  allowed: boolean;
  reason: ServiceEntitlementReason;
}

const allow = (reason: ServiceEntitlementReason): ServiceEntitlement => ({ allowed: true, reason });
const deny = (reason: ServiceEntitlementReason): ServiceEntitlement => ({ allowed: false, reason });

/**
 * O estabelecimento tem direito de operar AGORA?
 *
 * Só devolve `allowed: false` quando o motivo é demonstrável a partir do que
 * está persistido. Qualquer ambiguidade atende.
 */
export function resolveServiceEntitlement(
  est: Pick<Establishment, "billing">,
  now: number,
): ServiceEntitlement {
  const billing = est.billing;
  if (!billing) return allow("no_billing_record");

  switch (billing.billingStatus) {
    case "active":
      return allow("active");
    case "past_due":
      // Carência deliberada: o acesso é mantido enquanto a cobrança se
      // resolve. Quem decide que a carência terminou é o cron de expiração,
      // que move para "suspended" — e é ESSE estado que bloqueia.
      return allow("past_due");
    case "suspended":
      return deny("suspended");
    case "canceled":
      return deny("canceled");
    case "trial": {
      const { trialEndsAt } = billing;
      // Sem uma data confiável não há como provar que o trial terminou.
      // NUNCA inventa um limite (ex.: trialStartAt + N dias) — inventar uma
      // fronteira de cobrança é exatamente o que trialWindow.ts proíbe.
      if (typeof trialEndsAt !== "number" || !Number.isFinite(trialEndsAt)) {
        return allow("unprovable_billing_state");
      }
      return trialAllowsAccess(resolveTrialPhase(trialEndsAt, now))
        ? allow("trial_active")
        : deny("trial_expired");
    }
    default:
      // Valor persistido fora da união conhecida. Não é um estado que
      // autoriza cortar atendimento.
      return allow("unprovable_billing_state");
  }
}

/**
 * Kill switch operacional, no mesmo padrão de `campaignsSendEnabled()`:
 * habilitado por default, e `false` explícito no ambiente é rollback
 * imediato sem deploy. Lê env de propósito — é a única função impura daqui e
 * fica isolada para que `resolveServiceEntitlement` permaneça testável.
 */
export function billingEnforcementEnabled(): boolean {
  return process.env.BILLING_ENFORCEMENT_ENABLED !== "false";
}

/**
 * Decisão final usada pelo webhook: junta a policy ao kill switch.
 * Com o enforcement desligado, nada é bloqueado — mas o motivo continua
 * sendo devolvido, para permanecer observável em log.
 */
export function serviceBlockedByBilling(
  est: Pick<Establishment, "billing">,
  now: number,
): { blocked: boolean; reason: ServiceEntitlementReason } {
  const entitlement = resolveServiceEntitlement(est, now);
  return {
    blocked: !entitlement.allowed && billingEnforcementEnabled(),
    reason: entitlement.reason,
  };
}
