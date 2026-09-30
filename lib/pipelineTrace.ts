// Trace do pipeline de conversa: permite reconstruir o caminho de UMA mensagem
// (recebimento → processamento → IA/ferramentas/travas → envio) nos logs.
//
// Mesma escolha de lib/observability.ts: log estruturado no console, que a
// Vercel indexa — nenhuma leitura/escrita extra no Firestore. O contexto do
// trace viaja por AsyncLocalStorage, então brain/tools/entrega emitem eventos
// sem mudar assinaturas.
//
// Fail-open: nada aqui pode lançar para quem chama. Uma falha de telemetria
// nunca derruba um atendimento.
//
// Nunca registra: texto de mensagem, prompt, telefone, token, secret. Só
// identificadores técnicos (traceId é hash do wamid), contagens e estados.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type PipelineEvent =
  | "message_received"
  | "tenant_resolved"
  | "conversation_loaded"
  | "conversation_mode"
  | "handoff_state"
  | "task_state"
  | "context_built"
  | "llm_requested"
  | "llm_completed"
  | "tool_requested"
  | "tool_result"
  | "guardrail_result"
  | "message_queued"
  | "message_sent"
  | "processing_completed"
  | "processing_failed";

type TraceValue = string | number | boolean | null | undefined;
export type TraceData = Record<string, TraceValue>;

interface TraceContext {
  traceId: string;
  establishmentId?: string;
  attempt?: number;
  seq: number;
  startedAt: number;
}

export type TraceSink = (line: string) => void;

// Chaves que nunca saem, mesmo se alguém passar por engano.
const FORBIDDEN_KEY = /text|body|prompt|content|message(?!Count)|phone|token|secret|password|authorization|cookie|address|name$/i;
const MAX_STRING = 80;

let sink: TraceSink = (line) => console.log(line);
const storage = new AsyncLocalStorage<TraceContext>();

/** Só para testes: substitui o destino dos eventos. */
export function setTraceSink(next: TraceSink | null): void {
  sink = next ?? ((line) => console.log(line));
}

/** Hash curto e estável do wamid: correlaciona recebimento e retries sem expor o id. */
export function traceIdFor(messageId: string): string {
  try {
    return createHash("sha256").update(messageId).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

function sanitize(data: TraceData | undefined): TraceData {
  const out: TraceData = {};
  if (!data) return out;
  for (const [key, value] of Object.entries(data)) {
    if (FORBIDDEN_KEY.test(key) || value === undefined) continue;
    out[key] = typeof value === "string" ? value.slice(0, MAX_STRING) : value;
  }
  return out;
}

export function runWithTrace<T>(base: { messageId: string; establishmentId?: string; attempt?: number }, fn: () => Promise<T>): Promise<T> {
  let context: TraceContext | null = null;
  try {
    context = { traceId: traceIdFor(base.messageId), establishmentId: base.establishmentId, attempt: base.attempt, seq: 0, startedAt: Date.now() };
  } catch {
    context = null;
  }
  return context ? storage.run(context, fn) : fn();
}

/**
 * `data` pode ser uma função: ela só roda aqui dentro, protegida. Use-a
 * sempre que montar os dados exija ler campos de documentos (um campo ausente
 * num documento antigo não pode virar exceção no caminho do atendimento).
 */
export function traceEvent(event: PipelineEvent, data?: TraceData | (() => TraceData)): void {
  try {
    const context = storage.getStore();
    if (!context) return;
    context.seq += 1;
    const fields = sanitize(typeof data === "function" ? data() : data);
    sink(`[trace] ${JSON.stringify({
      traceId: context.traceId,
      seq: context.seq,
      event,
      ...(context.establishmentId ? { establishmentId: context.establishmentId } : {}),
      ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
      elapsedMs: Date.now() - context.startedAt,
      ...fields,
    })}`);
  } catch {
    // fail-open: telemetria nunca interrompe o atendimento
  }
}

export function currentTraceId(): string | null {
  try {
    return storage.getStore()?.traceId ?? null;
  } catch {
    return null;
  }
}
