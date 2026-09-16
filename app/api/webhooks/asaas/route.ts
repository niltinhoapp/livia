// Webhook Asaas (OT-06C, contrato fechado em OT-06B).
//
// Segurança: autenticação por secret PRÓPRIO do Webhook (ASAAS_WEBHOOK_TOKEN),
// enviado pela Asaas no header `asaas-access-token` — NUNCA a ASAAS_API_KEY
// (são credenciais de propósitos diferentes: uma autentica NÓS chamando a
// Asaas, a outra autentica a ASAAS chamando NÓS). Comparação em tempo
// constante, mesmo padrão do HMAC do webhook WhatsApp.
//
// Sempre responde 200 uma vez que o handler é invocado (mesmo em token
// inválido, payload malformado ou erro interno) — mesmo racional documentado
// no webhook WhatsApp: a Asaas interrompe a fila de eventos após 15 falhas
// consecutivas (não-2xx), e isso afetaria TODOS os eventos futuros, não só
// o que falhou. O motivo de qualquer rejeição vai para log sanitizado, nunca
// para o corpo da resposta.
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  createAsaasWebhookProcessingDependencies,
  processAsaasWebhookEvent,
  type AsaasWebhookProcessingResult,
} from "@/lib/billing/asaasWebhookProcessing";

function logStage(stage: string, data?: Record<string, unknown>) {
  console.log(`[asaas webhook] ${stage}`, data ? JSON.stringify(data) : "");
}

// Nunca loga o token recebido nem o configurado — só o resultado do
// comparativo. .trim() é defensivo pelo mesmo motivo do META_APP_SECRET no
// webhook WhatsApp (espaço/quebra de linha extra colado numa env var).
function verifyWebhookToken(header: string | null): boolean {
  const secret = process.env.ASAAS_WEBHOOK_TOKEN?.trim();
  if (!secret || !header) return false;
  const expected = Buffer.from(secret);
  const provided = Buffer.from(header);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("asaas-access-token");
  if (!verifyWebhookToken(token)) {
    logStage("token rejected", { tokenConfigured: Boolean(process.env.ASAAS_WEBHOOK_TOKEN) });
    return NextResponse.json({ received: true });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    logStage("json parse failed");
    return NextResponse.json({ received: true });
  }

  try {
    const dependencies = await createAsaasWebhookProcessingDependencies();
    const result = await processAsaasWebhookEvent(body, dependencies);
    logStage("processed", sanitizeResultForLog(result));
  } catch (err) {
    // Nunca deixa uma falha de processamento virar não-2xx (ver racional no
    // topo do arquivo) — só registra tipo/nome do erro, nunca stack/payload.
    logStage("unexpected error", { errorName: err instanceof Error ? err.name : typeof err });
  }

  return NextResponse.json({ received: true });
}

function sanitizeResultForLog(result: AsaasWebhookProcessingResult): Record<string, unknown> {
  // O tipo de resultado já não carrega payload bruto, customer, cpfCnpj nem
  // qualquer segredo — só outcome/event/establishmentId/generation/status,
  // todos identificadores técnicos, não dado sensível de cliente final.
  return { ...result };
}
