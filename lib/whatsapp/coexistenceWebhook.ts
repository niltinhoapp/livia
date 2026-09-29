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

export interface AgentEchoMessage {
  id: string;
  to: string;
  text: string;
}

/**
 * `smb_message_echoes`: mensagens que a equipe enviou pelo app WhatsApp
 * Business (Coexistence). São respostas do atendente humano — entram no
 * histórico com autoria "agent", nunca como mensagem do cliente.
 */
export function parseMessageEchoes(value: unknown): AgentEchoMessage[] {
  const echoes = (value as { message_echoes?: unknown } | undefined)?.message_echoes;
  if (!Array.isArray(echoes)) return [];
  return echoes.flatMap((raw): AgentEchoMessage[] => {
    if (!raw || typeof raw !== "object") return [];
    const echo = raw as { id?: unknown; to?: unknown; type?: unknown; text?: { body?: unknown } };
    if (typeof echo.id !== "string" || !echo.id || typeof echo.to !== "string" || !echo.to) return [];
    const body = typeof echo.text?.body === "string" ? echo.text.body.trim() : "";
    return [{ id: echo.id, to: echo.to, text: body || "[Anexo enviado pelo atendente]" }];
  });
}

/**
 * Eventos espelhados/sincronizados nunca são candidatos à IA.
 */
export function isAiEligibleWebhookChange(change: WebhookChangeLike): boolean {
  return classifyWebhookChange(change) === "customer_message";
}
