// Tradutor PURO de eventos do Webhook Asaas (OT-06C, contrato fechado em
// OT-06B). Nenhuma função aqui faz I/O — sem Firestore, sem chamada Asaas,
// sem process.env, sem Date.now() implícito. Mesmo padrão de isolamento de
// lib/billing/stateMachine.ts.
//
// A máquina de estados (stateMachine.ts) NUNCA recebe o vocabulário bruto do
// Asaas diretamente (README §4) — este módulo é exatamente a camada de
// tradução que faz essa ponte, mantendo o domínio da Lívia isolado.
import type { BillingEventType } from "./stateMachine";

// ---- Envelope ----
//
// Formato confirmado na documentação oficial (OT-06B):
// { id, event, dateCreated, payment?: {...} } ou { ..., subscription?: {...} }
export interface AsaasWebhookEnvelope {
  id: string;
  event: string;
  dateCreatedRaw: string;
  // O objeto de dados (payment ou subscription, o que estiver presente).
  // null quando o evento não carrega nenhum dos dois — estruturalmente
  // válido, mas não processável além de dedup/log.
  data: Record<string, unknown> | null;
}

export function parseAsaasWebhookEnvelope(raw: unknown): AsaasWebhookEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return null;
  if (typeof obj.event !== "string" || obj.event.length === 0) return null;
  if (typeof obj.dateCreated !== "string" || obj.dateCreated.length === 0) return null;
  const candidate = obj.payment ?? obj.subscription;
  const data = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
  return { id: obj.id, event: obj.event, dateCreatedRaw: obj.dateCreated, data };
}

// ---- Timestamp do envelope ----
//
// Formato observado na documentação oficial: "YYYY-MM-DD HH:mm:ss" — sem
// indicação explícita de timezone. Interpretado como UTC deliberadamente:
// usado SOMENTE para ordenação relativa entre eventos do próprio Asaas
// (nunca exibido ao usuário nem comparado a relógio de parede local), então
// a convenção de timezone não precisa ser exata — só precisa ser
// CONSISTENTE entre todos os eventos, o que UTC garante. Documentar como
// risco residual explícito (OT-06C).
const ENVELOPE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

export function parseAsaasEventTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = ENVELOPE_DATE_PATTERN.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? ms : null;
}

// ---- Tradução evento Asaas -> evento de domínio (contrato OT-06B) ----
//
// SUBSCRIPTION_INACTIVATED deliberadamente AUSENTE deste mapa: é
// semanticamente reversível (Asaas: "temporarily stops the generation of
// payments"), diferente de cancel (definitivo no domínio atual, só sai via
// reactivate administrativo). Reconhecido — nunca traduzido para um evento
// que não representa fielmente sua semântica.
const EVENT_TRANSLATION: Partial<Record<string, BillingEventType>> = {
  PAYMENT_CONFIRMED: "payment_confirmed",
  PAYMENT_RECEIVED: "payment_confirmed",
  PAYMENT_OVERDUE: "payment_overdue",
  SUBSCRIPTION_DELETED: "cancel",
};

export function translateAsaasEvent(eventName: string): BillingEventType | null {
  return EVENT_TRANSLATION[eventName] ?? null;
}

// Só para observabilidade/log: distingue "reconhecido, mas intencionalmente
// sem transição nesta V1" de "evento realmente desconhecido". Não afeta o
// resultado do processamento (ambos os casos são idênticos: reconhecido,
// deduplicado, sem transição) — só melhora o diagnóstico em log.
const RECOGNIZED_NO_TRANSITION_EVENTS = new Set<string>(["SUBSCRIPTION_INACTIVATED"]);

export function isRecognizedNoTransitionEvent(eventName: string): boolean {
  return RECOGNIZED_NO_TRANSITION_EVENTS.has(eventName);
}

// ---- Resolução de identidade por externalReference ----
//
// Formato exato produzido por logicalSubscriptionExternalReference()
// (lib/billing/provisioning.ts): "livia:subscription:{establishmentId}:{generation}".
// Fail-closed por design (OT-06B item 9): nunca faz lookup adicional na
// Asaas, nunca adivinha establishment por customer/subscription. Ausência ou
// formato inesperado => null, sem exceção.
const EXTERNAL_REFERENCE_PREFIX = "livia:subscription:";

export interface ResolvedBillingIdentity {
  establishmentId: string;
  generation: number;
}

export function resolveEstablishmentFromExternalReference(
  externalReference: unknown,
): ResolvedBillingIdentity | null {
  if (typeof externalReference !== "string" || !externalReference.startsWith(EXTERNAL_REFERENCE_PREFIX)) {
    return null;
  }
  const rest = externalReference.slice(EXTERNAL_REFERENCE_PREFIX.length);
  // Divide pelo ÚLTIMO ":" — establishmentId nunca contém "/" (validado na
  // criação), mas o tipo não proíbe ":"; usar lastIndexOf evita backtracking
  // de regex e lida corretamente mesmo se um dia isso acontecer.
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === rest.length - 1) return null;
  const establishmentId = rest.slice(0, lastColon);
  const generationRaw = rest.slice(lastColon + 1);
  if (!/^[1-9]\d*$/.test(generationRaw)) return null;
  const generation = Number(generationRaw);
  if (!Number.isSafeInteger(generation)) return null;
  return { establishmentId, generation };
}

export function extractExternalReference(data: Record<string, unknown> | null): unknown {
  return data?.externalReference;
}

// checkoutSession = id do Checkout que originou a subscription/payment —
// confirmado empiricamente no Asaas Sandbox (OT de migração pro Hosted
// Checkout): presente tanto no objeto subscription quanto no objeto
// payment, sempre que a origem é um Checkout. Usado como fallback de
// identidade SÓ quando externalReference não resolve (ver
// asaasWebhookProcessing.ts) — nunca substitui a resolução por
// externalReference, que continua a autoridade primária (fluxo PIX
// direto).
export function extractCheckoutSession(data: Record<string, unknown> | null): string | null {
  const value = data?.checkoutSession;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// id da subscription dona deste payment — já documentado oficialmente
// ("quando o payment pertence a uma subscription"). Usado só para persistir
// billing.externalSubscriptionId no momento da confirmação (necessário para
// o caminho Hosted Checkout, que nunca cria a subscription diretamente —
// só fica sabendo o id dela através do próprio evento de webhook).
export function extractSubscriptionId(data: Record<string, unknown> | null): string | null {
  const value = data?.subscription;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// nextDueDate só é persistido quando o próprio payload do evento o carrega
// (contrato OT-06B item 13: "quando aplicável/documentado"). payment.dueDate
// (a cobrança específica) NUNCA é confundido com nextDueDate (a assinatura).
export function extractNextDueDate(data: Record<string, unknown> | null): string | undefined {
  const value = data?.nextDueDate;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
