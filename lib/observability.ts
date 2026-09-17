// Observabilidade mínima de erro para Production (OT-READY-02).
//
// Escolha deliberada: log estruturado via console.error/JSON, sem
// dependência externa (Sentry/OTel/Pino/Winston). A Vercel já indexa saída
// de console e permite buscar/filtrar por texto no dashboard de Logs — hoje
// (fase de construção, sem clientes reais na base) isso já é suficiente
// para responder "onde/quando/qual operação/qual estabelecimento" quando
// algo falha. Reavaliar quando houver escala/tráfego real que justifique
// um provider dedicado.
//
// Nunca loga: stack completo, payload bruto, conteúdo de conversa, prompts,
// secrets, tokens, CPF/CNPJ, dados financeiros, áudio/imagem/binário. Só
// nome do erro + mensagem truncada — nunca o erro inteiro serializado.
export type ErrorCategory = "whatsapp_webhook" | "ai_openai" | "agenda" | "handoff" | "auth" | "api";

export interface ErrorLogContext {
  category: ErrorCategory;
  operation: string;
  // Identificador técnico, nunca acompanhado de nome/telefone/e-mail do
  // estabelecimento ou do cliente final.
  establishmentId?: string;
  requestId?: string;
  error: unknown;
}

function sanitizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message.slice(0, 300) };
  }
  return { name: typeof error, message: String(error).slice(0, 300) };
}

export function logError(ctx: ErrorLogContext): void {
  const { name, message } = sanitizeError(ctx.error);
  console.error(
    "[observability]",
    JSON.stringify({
      level: "error",
      category: ctx.category,
      operation: ctx.operation,
      ...(ctx.establishmentId ? { establishmentId: ctx.establishmentId } : {}),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      errorName: name,
      errorMessage: message,
      timestamp: new Date().toISOString(),
    }),
  );
}
