// Fundação do domínio de Billing (OT-05B) — máquina de estados PURA e
// decisão de acesso PURA. Nenhuma integração externa: sem Firestore, sem
// chamada HTTP/Asaas, sem process.env, sem Date.now() implícito. Tudo que
// depende de "agora" recebe `now` como parâmetro explícito, para
// determinismo e testabilidade (mesmo padrão de lib/ai/dayPeriod.ts).
//
// Dois eixos SEPARADOS de propósito (nunca misturados numa função só):
//   nextBillingStatus — dado o estado atual + um evento canônico, qual é o
//                        PRÓXIMO estado comercial. Não decide acesso.
//   canUseService      — dado o estado comercial ATUAL (já persistido), a
//                        Lívia pode operar agora? Não decide transição.
//
// Isolamento desta OT: NADA aqui escreve Firestore, altera
// Establishment.status ou panelAccess, ou chama o Asaas. É só a fundação de
// domínio — nenhuma rota/webhook/cron chama estas funções ainda.
import type { BillingStatus, Establishment } from "@/types";

// ---- Eventos canônicos internos ----
//
// A máquina NUNCA recebe o vocabulário bruto do Asaas (RECEIVED, CONFIRMED,
// OVERDUE, ...) diretamente — isso acopraria o domínio da Lívia ao provedor
// (README.md §11 proíbe exatamente isso). Traduzir um webhook do Asaas para
// um destes eventos é responsabilidade de uma camada futura, fora de escopo
// nesta OT.
//
//   payment_confirmed — Asaas confirmou/recebeu um pagamento da assinatura.
//   payment_overdue   — Asaas sinalizou atraso no pagamento da assinatura.
//   grace_expired      — a janela de tolerância após payment_overdue terminou
//                        sem pagamento. QUEM decide que a janela terminou
//                        (duração, cron) é responsabilidade de um chamador
//                        futuro (OT-05G) — a máquina só reage ao fato já
//                        decidido, não calcula prazos.
//   trial_expired      — o período de teste acabou SEM nenhum sinal de
//                        cobrança (nem confirmado, nem overdue) — rede de
//                        segurança para quando a assinatura nunca chegou a
//                        existir ou nenhum webhook chegou. Mesma observação:
//                        quem decide que o trial acabou é o chamador
//                        (compara trialEndsAt com `now`), não esta função.
//   cancel             — cancelamento, do tenant ou administrativo.
//   reactivate         — SEMPRE administrativo (ver comentário na tabela).
//                        Reativação por pagamento real usa payment_confirmed.
export type BillingEventType =
  | "payment_confirmed"
  | "payment_overdue"
  | "grace_expired"
  | "trial_expired"
  | "cancel"
  | "reactivate";

export interface BillingEvent {
  type: BillingEventType;
}

export type BillingTransitionResult =
  | { ok: true; next: BillingStatus }
  | { ok: false; reason: "invalid_transition" };

// Por que nextBillingStatus NÃO recebe `now`, embora um exemplo conceitual
// da ordem de trabalho sugerisse `(current, event, now)`: nenhuma transição
// desta tabela precisa saber que horas são — ela só reage a um evento que já
// representa um fato decidido (ex.: "o grace period acabou" é decidido por
// quem dispara grace_expired, não por esta função). Embutir `now` aqui
// juntaria duas responsabilidades — "quando o trial/grace expira" e "o que
// fazer quando expira" — que devem poder evoluir (e ser testadas)
// separadamente. A parte que de fato depende de `now` (o limite do trial)
// vive em canUseService(), abaixo.
//
// Tabela de transições — cada célula é uma decisão deliberada e documentada,
// nunca um default implícito. Ausência de entrada para um par
// (estado, evento) = transição inválida.
const TRANSITIONS: Record<BillingStatus, Partial<Record<BillingEventType, BillingStatus>>> = {
  trial: {
    payment_confirmed: "active",
    // O Asaas pode sinalizar atraso já na primeira cobrança (agendada para
    // trialEndsAt — ver OT-05A, seção ASAAS SUBSCRIPTION) — trata-se como
    // past_due normal, não como falha do trial em si.
    payment_overdue: "past_due",
    // Rede de segurança: a janela de teste fechou e NENHUM sinal de
    // cobrança chegou (nem confirmado, nem overdue) — vai direto para
    // suspended, sem passar por past_due. past_due fica reservado para
    // quando existe uma assinatura real que falhou ao cobrar; um trial sem
    // nenhum evento de cobrança nunca teve isso.
    trial_expired: "suspended",
    cancel: "canceled",
  },
  active: {
    // Idempotente de propósito: uma confirmação repetida (replay de
    // webhook) não pode mudar nada além do que já é verdade.
    payment_confirmed: "active",
    payment_overdue: "past_due",
    cancel: "canceled",
  },
  past_due: {
    payment_confirmed: "active",
    payment_overdue: "past_due", // idempotente, mesmo motivo de active acima
    grace_expired: "suspended",
    cancel: "canceled",
  },
  suspended: {
    // Pagamento real chegou depois da suspensão (ex.: cliente regularizou
    // fora da janela de grace) — reativa exatamente como past_due faria.
    payment_confirmed: "active",
    // Override administrativo (suporte/cortesia) — SEM pagamento real. Ver
    // decisão de origem logo abaixo.
    reactivate: "active",
    cancel: "canceled",
  },
  canceled: {
    // Deliberado: um tenant cancelado NUNCA volta sozinho por um webhook do
    // Asaas (nem payment_confirmed está na tabela aqui). Uma nova cobrança
    // após cancelamento é, no domínio da Lívia, um reprovisionamento
    // deliberado — só reactivate (administrativo) tira daqui, nunca um
    // evento de pagamento automático.
    reactivate: "active",
    // Idempotente: uma segunda confirmação de cancelamento (replay) não
    // pode falhar.
    cancel: "canceled",
  },
};

// Decisão sobre a origem de `reactivate` (obrigatória pela ordem de
// trabalho): é SEMPRE um evento administrativo — nunca disparado
// automaticamente por um webhook do Asaas. Um pagamento real que chega
// depois de suspended/canceled entra pela mesma tabela via
// payment_confirmed (válido em suspended, deliberadamente ausente em
// canceled — ver comentário acima). `reactivate` existe só para o caminho
// humano: suporte restaura o acesso sem depender de o Asaas ter processado
// nada. Quem pode chamar isso com esse evento (autenticação/autorização do
// admin) é responsabilidade de uma rota futura (fora de escopo aqui) — esta
// função só define que a transição É válida a partir de suspended/canceled.
export function nextBillingStatus(
  current: BillingStatus,
  event: BillingEvent,
): BillingTransitionResult {
  const next = TRANSITIONS[current]?.[event.type];
  if (!next) return { ok: false, reason: "invalid_transition" };
  return { ok: true, next };
}

// Decide se a Lívia pode operar AGORA para este estabelecimento — pura,
// síncrona, sem I/O. `now` é obrigatório (nunca Date.now() implícito aqui)
// para que o mesmo input sempre produza o mesmo output, em qualquer chamada
// e em qualquer teste.
//
// NÃO faz e não pode fazer: escrever Firestore, alterar
// Establishment.status, chamar o Asaas, ler env, ou alterar panelAccess —
// só lê o que já está persistido em `est.billing` e devolve um booleano.
export function canUseService(est: Pick<Establishment, "billing">, now: number): boolean {
  const billing = est.billing;
  // Ausência de `billing` = estabelecimento anterior a esta camada
  // (legado/grandfathered) — nunca bloqueado por um campo que ele nunca
  // teve chance de preencher. Mesma convenção já usada para panelAccess
  // (ausência = permitido) e whatsappBeta (ausência = elegível).
  if (!billing) return true;

  switch (billing.billingStatus) {
    case "active":
    case "past_due": // grace period: acesso mantido enquanto a cobrança se resolve
      return true;
    case "suspended":
    case "canceled":
      return false;
    case "trial": {
      const { trialEndsAt } = billing;
      // Fail-safe deliberado: billingStatus diz "trial" mas trialEndsAt
      // está ausente ou não é um número finito (dado corrompido/malformado
      // — nunca deveria acontecer num registro criado pelo provisionamento,
      // mas esta função não pode confiar cegamente no que está persistido).
      // NUNCA inventa uma data nova (trialStartAt + 7 dias): se a única
      // fonte de verdade do limite está quebrada, não há como provar que o
      // trial ainda vale — falha FECHADO (bloqueia), não aberto. Mesmo
      // princípio já usado no projeto para campo persistido inesperado
      // (ex.: lib/whatsapp/coexistence.ts: normalizeConnectionMode).
      if (typeof trialEndsAt !== "number" || !Number.isFinite(trialEndsAt)) return false;
      // No limite exato, o trial ainda vale — trialEndsAt é o último
      // instante permitido, não o primeiro bloqueado.
      return now <= trialEndsAt;
    }
  }
}
