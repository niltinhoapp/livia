// Janela do trial em torno de trialEndsAt — regra definitiva de produto
// (auditoria pré-primeiro-pagamento real). Tudo calculado por TIMESTAMP,
// nunca por "dia de calendário" — e compartilhado entre as duas rotas de
// pagamento (subscribe/checkout), a state machine (canUseService) e a UI
// (/painel/plano), pelo mesmo motivo que resolveTargetGeneration foi
// extraído para generation.ts: as fronteiras de tempo NUNCA podem divergir
// entre os lugares que decidem "posso cobrar?" e "o cliente ainda tem
// acesso?" — uma única fonte de verdade evita um buraco de tempo entre
// backend e UI. Módulo puro: sem Firestore, sem process.env, sem
// Date.now() implícito (now sempre explícito, mesmo padrão de
// stateMachine.ts).
//
// Linha do tempo (trialEndsAt = fim nominal dos 7 dias grátis):
//
//   antes de trialEndsAt-24h  : Lívia funciona; PIX/cartão BLOQUEADOS
//                               (nenhuma cobrança pode nascer no Asaas).
//   [trialEndsAt-24h, trialEndsAt): último dia do trial; Lívia funciona;
//                               PIX/cartão liberados ("termina em breve").
//   [trialEndsAt, trialEndsAt+24h): tolerância de regularização; Lívia
//                               continua funcionando; PIX/cartão liberados;
//                               NUNCA apresentada como "8º dia grátis".
//   trialEndsAt+24h em diante : sem pagamento confirmado pelo webhook,
//                               suspende; PIX/cartão continuam liberados
//                               (para regularizar); reativação segue a
//                               state machine existente via
//                               payment_confirmed.
//
// Limites (auditados um a um, nunca "por perto"): o instante exato
// trialEndsAt-24h já libera pagamento (>=); o instante exato trialEndsAt
// ainda NÃO suspende (é o início da tolerância, não o fim dela); o instante
// exato trialEndsAt+24h já é considerado expirado (>=) — mesma convenção de
// "limite é o último instante do lado de dentro" já usada em
// stateMachine.ts::canUseService antes desta mudança.
export const TRIAL_PAYMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TRIAL_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type TrialPhase =
  | "before_window" // pagamento bloqueado, Lívia funciona normalmente
  | "final_day" // último dia do trial: pagamento liberado, ainda "grátis"
  | "grace" // tolerância pós-trialEndsAt: pagamento liberado, acesso mantido
  | "expired"; // tolerância encerrada: sem pagamento confirmado, suspende

export function resolveTrialPhase(trialEndsAt: number, now: number): TrialPhase {
  const paymentOpensAt = trialEndsAt - TRIAL_PAYMENT_WINDOW_MS;
  const graceEndsAt = trialEndsAt + TRIAL_GRACE_WINDOW_MS;
  if (now < paymentOpensAt) return "before_window";
  if (now < trialEndsAt) return "final_day";
  if (now < graceEndsAt) return "grace";
  return "expired";
}

// PIX/cartão nunca podem nascer antes de trialEndsAt-24h — em qualquer
// outra fase (inclusive "expired", pra permitir regularização) o pagamento
// é permitido. Quem decide se o ACESSO à Lívia continua é
// trialAllowsAccess, uma decisão SEPARADA (mesmo princípio de
// nextBillingStatus/canUseService em stateMachine.ts: transição e acesso
// nunca se misturam).
export function trialAllowsPaymentCreation(phase: TrialPhase): boolean {
  return phase !== "before_window";
}

// Acesso à Lívia continua em before_window/final_day/grace — só "expired"
// (tolerância de 24h já esgotada, sem pagamento confirmado) bloqueia.
export function trialAllowsAccess(phase: TrialPhase): boolean {
  return phase !== "expired";
}

// Gate único, compartilhado pelas DUAS rotas de pagamento (subscribe e
// checkout) — "posso criar uma cobrança/Checkout AGORA para este
// establishment?". Só bloqueia quando billingStatus é exatamente "trial" e
// ainda está em before_window; qualquer outro status (active/past_due/
// suspended/canceled) nunca passa por este gate — a regra é só sobre não
// deixar a assinatura nascer ANTES do trial permitir, nunca uma trava geral
// de pagamento. trialEndsAt ausente/corrompido NUNCA bloqueia pagamento
// (diferente de canUseService, que falha fechado pro ACESSO): sem uma data
// confiável não há como provar que é cedo demais, e bloquear a única forma
// do cliente regularizar seria pior que o problema que o fail-safe tenta
// evitar — o pagamento, uma vez confirmado, corrige o billingStatus de
// qualquer forma.
export function isTrialPaymentBlocked(
  billing: { billingStatus: string; trialEndsAt?: number } | undefined,
  now: number,
): boolean {
  if (!billing || billing.billingStatus !== "trial") return false;
  const { trialEndsAt } = billing;
  if (typeof trialEndsAt !== "number" || !Number.isFinite(trialEndsAt)) return false;
  return !trialAllowsPaymentCreation(resolveTrialPhase(trialEndsAt, now));
}
