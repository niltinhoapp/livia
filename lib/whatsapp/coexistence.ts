/**
 * Regras puras do WhatsApp Coexistence.
 *
 * Este módulo não chama a Meta, não acessa Firestore e não dispara IA.
 * Ele concentra decisões que precisam permanecer determinísticas para que
 * o fluxo Cloud API existente continue separado do fluxo Coexistence.
 */

export type WhatsappConnectionMode = "cloud_api" | "coexistence";

export type CoexistenceEventType =
  | "smb_message_echoes"
  | "history"
  | "smb_app_state_sync";

export type IncomingWebhookKind =
  | "customer_message"
  | "message_echo"
  | "history"
  | "app_state_sync"
  | "status"
  | "unknown";

/**
 * Coexistence dispensa o registro /register do número.
 * Cloud API continua exigindo o comportamento atual.
 */
export function shouldRegisterPhone(mode: WhatsappConnectionMode): boolean {
  return mode === "cloud_api";
}

/**
 * Eventos de sincronização/espelhamento nunca entram no pipeline da IA.
 */
export function shouldTriggerAi(kind: IncomingWebhookKind): boolean {
  return kind === "customer_message";
}

export function classifyCoexistenceEvent(value: unknown): IncomingWebhookKind {
  if (value === "smb_message_echoes") return "message_echo";
  if (value === "history") return "history";
  if (value === "smb_app_state_sync") return "app_state_sync";
  return "unknown";
}

/**
 * Normaliza o modo recebido de forma conservadora.
 * Qualquer valor desconhecido cai no fluxo Cloud API, evitando ativar
 * Coexistence por input inválido.
 */
export function normalizeConnectionMode(value: unknown): WhatsappConnectionMode {
  return value === "coexistence" ? "coexistence" : "cloud_api";
}
