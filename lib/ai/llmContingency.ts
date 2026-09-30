// Contingência para falha persistente do LLM. Regras puras (sem Firestore,
// Meta ou IA): o webhook decide COM ELAS se a mensagem volta para o retry
// existente do inbox ou se a conversa vai para atendimento humano.
//
// O retry continua sendo o do job do inbox (lib/repo.ts: failWhatsAppInboundJob,
// backoff 1→2→4… min). Aqui não há retry novo: só o ponto de parada, para o
// cliente nunca ficar em silêncio indefinido.

export type AiFailureKind =
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  // 4xx do provedor (requisição inválida, credencial): repetir não resolve.
  | "provider_rejected"
  | "internal_error";

// Na 3ª falha seguida da MESMA mensagem (≈3 min com o backoff atual), a
// conversa vai para humano. Falha que repetir não resolve age na primeira.
export const LLM_CONTINGENCY_ATTEMPT = 3;

// Texto único e neutro: não confirma pedido nem agendamento, não informa
// disponibilidade nem preço, não revela detalhe técnico.
export const LLM_CONTINGENCY_REPLY =
  "Estou com uma instabilidade no atendimento automático. Vou encaminhar sua conversa para uma pessoa da equipe, que continua por aqui.";

// Pelo formato, não por classe: os erros do SDK openai não definem `name`
// (todos saem "Error"), o bundle de produção pode renomear classes e vários
// testes fazem vi.mock("openai"). Todo APIError do SDK tem `status` e
// `headers` próprios; erro de conexão/timeout tem os dois indefinidos.
export function classifyAiFailure(error: unknown): AiFailureKind {
  if (!error || typeof error !== "object") return "internal_error";
  const e = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message : "";
  const status = typeof e.status === "number" ? e.status : undefined;
  const fromProvider = "status" in e && "headers" in e;
  if (/timeout/i.test(name) || e.code === "ETIMEDOUT" || status === 408 || (fromProvider && status === undefined && /timed out/i.test(message))) return "timeout";
  if (status === 429) return "rate_limited";
  if ((status !== undefined && status >= 500) || status === 409 || (fromProvider && status === undefined) || e.code === "ECONNRESET" || e.code === "ECONNREFUSED") return "provider_unavailable";
  if (status !== undefined && status >= 400) return "provider_rejected";
  return "internal_error";
}

/** `previousAttempts` = falhas anteriores registradas no job (job.attempts). */
export function shouldActivateLlmContingency(kind: AiFailureKind, previousAttempts: number): boolean {
  if (kind === "provider_rejected") return true;
  return previousAttempts + 1 >= LLM_CONTINGENCY_ATTEMPT;
}
