import {
  classifyCoexistenceEvent,
  type IncomingWebhookKind,
} from "@/lib/whatsapp/coexistence";

export interface WebhookChangeLike {
  field?: unknown;
  value?: unknown;
}

/**
 * Classifica um change do webhook sem tocar Firestore, Meta ou IA.
 * Campos de Coexistence têm prioridade: mesmo que o payload carregue
 * estruturas parecidas com `messages`, o evento especial nunca deve cair no
 * pipeline de atendimento automático.
 */
export function classifyWebhookChange(change: WebhookChangeLike): IncomingWebhookKind {
  const special = classifyCoexistenceEvent(change.field);
  if (special !== "unknown") return special;

  const value = change.value as { messages?: unknown; statuses?: unknown } | undefined;
  if (Array.isArray(value?.messages) && value.messages.length > 0) return "customer_message";
  if (Array.isArray(value?.statuses) && value.statuses.length > 0) return "status";
  return "unknown";
}

/**
 * Eventos espelhados/sincronizados nunca são candidatos à IA.
 */
export function isAiEligibleWebhookChange(change: WebhookChangeLike): boolean {
  return classifyWebhookChange(change) === "customer_message";
}
