// Webhook Asaas (OT-06C, contrato fechado em OT-06B; política HTTP
// corrigida em OT-06C.1).
//
// Segurança: autenticação por secret PRÓPRIO do Webhook (ASAAS_WEBHOOK_TOKEN),
// enviado pela Asaas no header `asaas-access-token` — NUNCA a ASAAS_API_KEY
// (são credenciais de propósitos diferentes: uma autentica NÓS chamando a
// Asaas, a outra autentica a ASAAS chamando NÓS). Comparação em tempo
// constante, mesmo padrão do HMAC do webhook WhatsApp.
//
// POLÍTICA DE RESPOSTA HTTP (revisada em OT-06C.1 — nunca copiar
// cegamente o "sempre 200" do webhook WhatsApp; os dois domínios têm risco
// diferente. Base: documentação oficial Asaas — docs.asaas.com/docs/erro-400-bad-request
// ("responda HTTP 200 após confirmar a persistência") e
// docs.asaas.com/docs/erro-403-forbidden (falha de autenticação é uma
// categoria de erro ESPERADA e MONITORADA nos próprios Logs de Webhook da
// Asaas — mascará-la como 200 esconde o problema até do painel deles)):
//
//   200 -> evento autenticado E cuja decisão (aplicar, ignorar
//          deliberadamente, descartar por duplicidade/fora de
//          ordem/identidade não resolvida/transição inválida) já está
//          durável. "200" aqui significa literalmente "não me reenvie
//          este id" — nunca é emitido antes disso.
//   400 -> autenticado, mas o corpo não é um envelope Asaas válido (JSON
//          quebrado, ou faltam id/event/dateCreated — os 3 campos que TODO
//          evento real da Asaas sempre traz, confirmado na documentação;
//          não é o caso de "campo opcional novo", que a doc de erro 400
//          pede para nunca rejeitar). Sinaliza um problema real (nosso
//          parser ou a origem) sem fingir sucesso.
//   401 -> asaas-access-token ausente ou incorreto. NÃO mascarado como 200:
//          a doc de erro 403 trata isso como categoria de erro que a
//          própria Asaas espera ver e monitorar nos Logs de Webhook — um
//          401 aqui é o comportamento correto e documentado, não um
//          incidente a esconder.
//   503 -> falha transitória/interna (ex.: Firestore indisponível) ANTES de
//          garantir que o evento foi persistido/aplicado com segurança.
//          Nunca confirma um evento financeiro que pode não ter sido
//          gravado — deixa a Asaas reenviar, exatamente o mecanismo de
//          retry que a doc documenta para esse propósito.
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

// Todo outcome de processAsaasWebhookEvent, exceto "invalid_envelope", já
// representa uma decisão durável (aplicada ou deliberadamente descartada) —
// "invalid_envelope" é o único que significa "não consegui nem interpretar
// isso", tratado separadamente como 400 antes de chegar aqui.
function statusForOutcome(result: AsaasWebhookProcessingResult): number {
  return result.outcome === "invalid_envelope" ? 400 : 200;
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("asaas-access-token");
  if (!verifyWebhookToken(token)) {
    logStage("token rejected", { tokenConfigured: Boolean(process.env.ASAAS_WEBHOOK_TOKEN) });
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    logStage("json parse failed");
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  try {
    const dependencies = await createAsaasWebhookProcessingDependencies();
    const result = await processAsaasWebhookEvent(body, dependencies);
    logStage("processed", sanitizeResultForLog(result));
    const status = statusForOutcome(result);
    return NextResponse.json(
      status === 200 ? { received: true } : { error: "INVALID_PAYLOAD" },
      { status },
    );
  } catch (err) {
    // Falha ANTES de garantir persistência — nunca confirma um evento
    // financeiro que pode não ter sido aplicado. Só tipo/nome do erro no
    // log, nunca stack/payload/segredo.
    logStage("processing failed", { errorName: err instanceof Error ? err.name : typeof err });
    return NextResponse.json({ error: "PROCESSING_FAILED" }, { status: 503 });
  }
}

function sanitizeResultForLog(result: AsaasWebhookProcessingResult): Record<string, unknown> {
  // O tipo de resultado já não carrega payload bruto, customer, cpfCnpj nem
  // qualquer segredo — só outcome/event/establishmentId/generation/status,
  // todos identificadores técnicos, não dado sensível de cliente final.
  return { ...result };
}
