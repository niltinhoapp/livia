// Webhook do WhatsApp — o núcleo da Livia.
//
// GET  -> verificação (handshake com hub.challenge).
// POST -> recebe a mensagem do cliente, identifica o estabelecimento,
//         carrega base de conhecimento + histórico, chama a IA e responde.
//
// O POST só confirma sucesso depois que TODAS as mensagens válidas do lote
// estão no inbox durável. Processamento pesado acontece depois dessa barreira;
// falhar antes dela devolve 503 para a Meta reenviar o lote com segurança.
//
// Segurança: o POST valida a assinatura HMAC-SHA256 (X-Hub-Signature-256) com
// o META_APP_SECRET sobre o corpo cru — sem isso, qualquer um forjaria
// mensagens/eventos (ex.: confirmar ou cancelar agendamento de um cliente
// alheio). Mesmo padrão do webhook do Nuvem Rush.
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logError } from "@/lib/observability";
import {
  findEstablishmentByPhoneNumberId,
  getEstablishment,
  getConversation,
  getKnowledgeBase,
  loadConversation,
  appendMessage,
  setConversationStatus,
  transitionConversationStatusWithLease,
  setAwaitingHumanOfferConfirmation,
  closeConversation,
  tryCloseAutomatedConversation,
  reopenConversation,
  setConversationIntent,
  setConversationTask,
  setConversationSummary,
  getCustomerProfile,
  upsertCustomerProfile,
  upsertPendingTask,
  resolvePendingTask,
  getPendingTask,
  alreadyProcessed,
  enqueueWhatsAppInboundJob,
  listWhatsAppInboundJobs,
  completeWhatsAppInboundJob,
  failWhatsAppInboundJob,
  quarantineOrphanWhatsAppInboundJobs,
  quarantineWhatsAppInboundSequenceGap,
  tryAcquireConversationProcessingLease,
  renewConversationProcessingLease,
  releaseConversationProcessingLease,
  releaseConversationProcessingLeaseIfDrained,
  applyCampaignDeliveryStatus,
  correlateCampaignReply,
} from "@/lib/repo";
import {
  executeDurableWhatsAppOutbound,
  getWhatsAppOutboundIntent,
  OutboundIntentConflictError,
  OutboundReconciliationRequiredError,
  OutboundRetryableError,
} from "@/lib/whatsapp/outbox";
import {
  sendText,
  sendAudio,
  markAsRead,
  downloadWhatsAppAudio,
  downloadWhatsAppMedia,
  WhatsAppMediaError,
  WhatsAppAudioSendError,
  WhatsAppTextSendError,
} from "@/lib/whatsapp/client";
import {
  AttachmentStorageError,
  deleteConversationAttachment,
  storeConversationAttachment,
} from "@/lib/attachments/storage";
import { think } from "@/lib/ai/brain";
import { detectIntent } from "@/lib/ai/intent";
import { confirmCancelReminderIntent } from "@/lib/ai/reminderConfirmation";
import { deriveTaskState } from "@/lib/ai/taskState";
import { derivePendingTask } from "@/lib/ai/pendingTask";
import { summarizeConversation } from "@/lib/ai/summarize";
import { SERVICE_PAUSED_REPLY, warnedServicePausedRecently } from "@/lib/servicePaused";
import { findNextAppointment, setStatus, findCustomerNameFromAppointments } from "@/lib/scheduling";
import { normalizePhone } from "@/lib/whatsapp/client";
import { readConfirmation } from "@/lib/ai/confirmation";
import { acceptsHumanOffer, offeredHuman, readHumanIntent } from "@/lib/ai/humanRequest";
import { isSilentAcknowledgement } from "@/lib/ai/acknowledgement";
import { declaresAutomatedRecipient, isClearClosingReply, isClearHumanDemand, isPureSocialFarewell } from "@/lib/ai/conversationClosure";
import { classifyWebhookChange } from "@/lib/whatsapp/coexistenceWebhook";
import { getWhatsappTestCredentials } from "@/lib/whatsapp/testCredentials";
import { parseInboundMessage, type MetaInboundMessage } from "@/lib/whatsapp/inboundMessage";
import { transcribeAudio, AudioTranscriptionError } from "@/lib/ai/transcription";
import { synthesizeSpeech, SpeechError } from "@/lib/ai/speech";
import type {
  Establishment,
  EstablishmentWhatsapp,
  ConversationTask,
  CustomerProfile,
  MessageMedia,
  MessageAttachment,
  MessageTranscription,
  WhatsAppInboundJob,
} from "@/types";

const AUDIO_FAILURE_REPLY = "Não consegui entender esse áudio. Pode enviar novamente ou escrever a mensagem?";

class WhatsAppChannelGenerationError extends Error {
  constructor() {
    super("whatsapp_channel_generation_changed");
    this.name = "WhatsAppChannelGenerationError";
  }
}

function inboundFailureCode(error: unknown): string {
  if (error instanceof OutboundRetryableError || error instanceof OutboundReconciliationRequiredError) return error.code;
  if (error instanceof OutboundIntentConflictError) return error.message;
  if (error instanceof WhatsAppChannelGenerationError) return error.message;
  if (error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message)) return error.message.slice(0, 120);
  return error instanceof Error ? error.name : "unknown_error";
}

// Log de diagnóstico do webhook — nunca inclui secret/token/telefone/texto da
// mensagem. Identificadores técnicos são mascarados; contagens e estados são
// preservados. Existe porque "POST 200" não
// prova que a mensagem foi processada: o caso real que motivou isto foi o
// webhook retornando 200 em ~8ms, sem nenhuma chamada externa — a assinatura
// estava falhando e ninguém sabia exatamente por quê (secret ausente? header
// ausente? assinatura não bate?), porque o retorno era idêntico nos três casos.
const IDENTIFIER_LOG_FIELDS = new Set(["msgId", "estId", "conversationId", "phoneNumberId", "wabaId"]);

function maskIdentifier(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= 4) return "[redacted]";
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}

function sanitizeLogData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, IDENTIFIER_LOG_FIELDS.has(key) ? maskIdentifier(value) : value]),
  );
}

function logStage(stage: string, data?: Record<string, unknown>) {
  console.log(`[livia webhook] ${stage}`, data ? JSON.stringify(sanitizeLogData(data)) : "");
}

function audioErrorCode(err: unknown): string {
  if (err instanceof WhatsAppMediaError || err instanceof AudioTranscriptionError) return err.code;
  return "unexpected_error";
}

function attachmentErrorCode(err: unknown): string {
  if (err instanceof WhatsAppMediaError || err instanceof AttachmentStorageError) return err.code;
  return "unexpected_error";
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const mode = p.get("hub.mode");
  const token = p.get("hub.verify_token");
  const challenge = p.get("hub.challenge");
  const configured = Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
  if (mode === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    logStage("verify ok");
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  // "tokenConfigured" diz, sem vazar o valor, se WHATSAPP_WEBHOOK_VERIFY_TOKEN
  // sequer existe neste deployment — a primeira coisa a checar quando a
  // verificação falha.
  logStage("verify failed", { mode, tokenConfigured: configured });
  return NextResponse.json({ error: "verificação inválida" }, { status: 403 });
}

// Motivo exato de uma assinatura não bater — sem isso, "secret não
// configurado", "header ausente" e "assinatura errada" são indistinguíveis
// nos logs (as três retornam o mesmo 200 silencioso, por design, pra Meta não
// desativar o webhook). Nenhum dos três casos loga o valor do secret/header.
type SignatureCheck = { ok: true } | { ok: false; reason: "no_secret" | "no_header" | "mismatch" };

// Valida X-Hub-Signature-256 (sha256=<hmac do corpo cru com META_APP_SECRET>).
function verifySignature(rawBody: string, header: string | null): SignatureCheck {
  // .trim() aqui é defensivo: valores colados manualmente numa env var (ex.
  // via prompt interativo do `vercel env add`) podem carregar um espaço ou
  // quebra de linha extra no final, o que quebraria o HMAC silenciosamente
  // sem nenhum erro visível — só a assinatura nunca batendo.
  const secret = process.env.META_APP_SECRET?.trim();
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!header?.startsWith("sha256=")) return { ok: false, reason: "no_header" };
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const provided = header.slice("sha256=".length);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  const matches = a.length === b.length && timingSafeEqual(a, b);
  return matches ? { ok: true } : { ok: false, reason: "mismatch" };
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  logStage("received", { bytes: raw.length });

  // Assinatura ausente/inválida/não confere -> ignora (responde 200 mesmo
  // assim para a Meta não desativar o webhook por erros repetidos). O motivo
  // vai pro log — é a diferença entre "nunca vou descobrir por que parou de
  // responder" e "META_APP_SECRET sumiu do deployment, é só isso".
  const signature = verifySignature(raw, req.headers.get("x-hub-signature-256"));
  if (!signature.ok) {
    logStage("signature rejected", { reason: signature.reason });
    return NextResponse.json({ received: true });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch (err) {
    logStage("payload parse failed", { errorType: err instanceof Error ? err.name : "unknown" });
    return NextResponse.json({ received: true });
  }

  try {
    await handleWebhook(body);
  } catch (err) {
    // Não silencioso: qualquer exceção não tratada por um passo específico
    // (ver os try/catch nomeados dentro de handleWebhook) cai aqui e fica
    // visível nos logs — nunca é engolida. Também é o boundary que capta
    // erro não tratado da camada de IA (lib/ai/gateway.ts propaga de
    // propósito, sem try/catch próprio) e de handoff (ambos vivem dentro de
    // handleWebhook, sem módulo próprio).
    logError({ category: "whatsapp_webhook", operation: "handle_webhook", error: err });
    console.error("[livia webhook] erro não tratado", {
      errorType: err instanceof Error ? err.name : "unknown",
    });
    // Antes da barreira durável, 200 perderia a mensagem para sempre. Jobs já
    // persistidos são idempotentes, então uma reentrega do lote é segura.
    return NextResponse.json({ received: false, retry: true }, { status: 503 });
  }
  return NextResponse.json({ received: true });
}

// Webhook de status (sent/delivered/read/failed) — a Meta entrega isto num
// change separado dos que carregam messages[], já classificado como "status"
// por classifyWebhookChange. Antes disto o webhook não olhava value.statuses
// em lugar nenhum: um POST só com status caía direto em "no incoming message
// in payload" e qualquer erro real de entrega (ex.: 131047 fora da janela de
// 24h) ficava sem nenhum rastro — foi exatamente o que aconteceu no
// incidente de Production que motivou isto: a Graph API aceitou o envio e
// devolveu um wamid, mas a mensagem nunca chegou, e o status de falha
// correspondente não deixava vestígio.
//
// Só log — não persiste, não muda dedupe, não toca conversation/task, não
// entra no pipeline de IA. `phoneNumberId`/`msgId` passam pela mesma máscara
// de identificador já usada no resto do arquivo (IDENTIFIER_LOG_FIELDS);
// nunca loga o telefone do destinatário (`recipient_id`), token, secret ou
// texto de mensagem.
function logStatusUpdates(value: WebhookValue | undefined): void {
  const statuses = value?.statuses ?? [];
  if (statuses.length === 0) return;

  const phoneNumberId = value?.metadata?.phone_number_id;
  logStage("status webhook received", { phoneNumberId, count: statuses.length });

  for (const s of statuses) {
    const error = s.errors?.[0];
    logStage("status update", {
      msgId: s.id,
      phoneNumberId,
      status: s.status,
      ...(error?.code !== undefined ? { errorCode: error.code } : {}),
      ...(error?.title || error?.message ? { errorTitle: error.title ?? error.message } : {}),
    });
  }
}

function mapMetaDeliveryStatus(raw: string | undefined): "sent" | "delivered" | "read" | "failed" | null {
  return raw === "sent" || raw === "delivered" || raw === "read" || raw === "failed" ? raw : null;
}

// CAMPANHAS-07: mesmo webhook, sem novo endpoint. Correlaciona cada status
// pelo wamid (`s.id`) a um CampaignRecipient — só chega aqui depois de
// logStatusUpdates já ter registrado o evento bruto. O tenant vem SEMPRE de
// findEstablishmentByPhoneNumberId (nunca de um establishmentId no corpo do
// payload, que nem existe no formato real da Meta). Um wamid desconhecido
// (não é de nenhuma campanha) é um no-op silencioso — a imensa maioria das
// mensagens da Lívia não é campanha.
async function correlateCampaignStatusUpdates(value: WebhookValue | undefined): Promise<void> {
  const statuses = value?.statuses ?? [];
  const phoneNumberId = value?.metadata?.phone_number_id;
  if (statuses.length === 0 || !phoneNumberId) return;

  const est = await findEstablishmentByPhoneNumberId(phoneNumberId);
  if (!est) return;

  for (const s of statuses) {
    const status = mapMetaDeliveryStatus(s.status);
    if (!s.id || !status) continue;
    const error = s.errors?.[0];
    try {
      await applyCampaignDeliveryStatus(
        est.id,
        s.id,
        status,
        error ? { code: error.code, title: error.title ?? error.message } : undefined,
      );
    } catch (correlationError) {
      console.error("[livia webhook] campaign status correlation failed", {
        errorType: correlationError instanceof Error ? correlationError.name : "unknown",
      });
    }
    // A mesma callback também pode pertencer a uma notificação operacional
    // de pedido. O lookup continua escopado ao tenant resolvido pelo
    // phoneNumberId; wamid desconhecido é no-op, como em Campanhas.
    try {
      const { applyOrderNotificationDeliveryStatus } = await import("@/lib/orderNotifications");
      await applyOrderNotificationDeliveryStatus(
        est.id,
        s.id,
        status,
        error ? { code: error.code, title: error.title ?? error.message } : undefined,
      );
    } catch (correlationError) {
      console.error("[livia webhook] order notification status correlation failed", {
        errorType: correlationError instanceof Error ? correlationError.name : "unknown",
      });
    }
  }
}

async function handleWebhook(body: WebhookBody): Promise<void> {
  // A Meta pode enviar mais de um entry/change/message no mesmo POST (ex.:
  // duas mensagens do cliente em rápida sucessão chegam batched). O código
  // só olhava entry[0].changes[0].messages[0] — qualquer mensagem além dessa
  // era descartada em silêncio, sem log e sem erro. Processa todas, em ordem.
  const messages: { value: WebhookValue; msg: MetaInboundMessage }[] = [];
  // Coexistence: eventos de espelhamento/sincronização não são mensagens
  // novas do cliente. Eles nunca podem chegar ao pipeline da Livia/IA.
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const kind = classifyWebhookChange(change);
      if (kind === "message_echo" || kind === "history" || kind === "app_state_sync") {
        logStage("coexistence sync event ignored", { kind });
        continue;
      }
      if (kind === "status") {
        logStatusUpdates(change.value);
        try {
          await correlateCampaignStatusUpdates(change.value);
        } catch (err) {
          console.error("[livia webhook] campaign status correlation failed", {
            errorType: err instanceof Error ? err.name : "unknown",
          });
        }
        continue;
      }

      const value = change.value;
      for (const msg of value?.messages ?? []) {
        messages.push({ value: value!, msg });
      }
    }
  }

  if (messages.length === 0) {
    logStage("no incoming message in payload", { entries: body.entry?.length ?? 0 });
    return;
  }

  logStage("messages in payload", { count: messages.length });
  // Barreira durável: nenhuma IA, mídia ou entrega começa antes que todas as
  // mensagens válidas do lote estejam no Firestore.
  const targets = await Promise.all(messages.map(({ value, msg }) => persistInboundMessage(value, msg)));
  const unique = new Map<string, { establishmentId: string; conversationId: string }>();
  for (const target of targets) {
    if (target) unique.set(`${target.establishmentId}:${target.conversationId}`, target);
  }

  // Falhas posteriores são recuperáveis pelo inbox e não anulam a persistência
  // das outras conversas do lote.
  const drains = await Promise.allSettled([...unique.values()].map((target) =>
    drainConversationInbox(target.establishmentId, target.conversationId)));
  for (const result of drains) {
    if (result.status === "rejected") {
      console.error("[livia webhook] durable drain failed", {
        errorType: result.reason instanceof Error ? result.reason.name : "unknown",
      });
    }
  }
}

async function resolveInboundEstablishment(value: WebhookValue): Promise<Establishment | null> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return null;
  const testCredentials = getWhatsappTestCredentials();
  if (testCredentials?.phoneNumberId === phoneNumberId) {
    return getEstablishment(testCredentials.establishmentId);
  }
  const est = await findEstablishmentByPhoneNumberId(phoneNumberId);
  return est?.whatsapp?.status === "connected" ? est : null;
}

async function persistInboundMessage(
  value: WebhookValue,
  msg: MetaInboundMessage,
): Promise<{ establishmentId: string; conversationId: string } | null> {
  if (!value.metadata?.phone_number_id) {
    logStage("message without phone_number_id, ignored", { msgId: msg.id });
    return null;
  }

  const inbound = parseInboundMessage(msg);
  if (!inbound.from) {
    logStage("message without sender, ignored", { msgId: msg.id });
    return null;
  }

  if (!inbound.waMessageId) {
    logStage("message without waMessageId, ignored", { msgId: msg.id });
    return null;
  }
  // Dedupe somente de CONCLUSÃO. Recebimentos em andamento são deduplicados
  // pelo documento do inbox, sem se tornarem irrecuperáveis.
  if (await alreadyProcessed(inbound.waMessageId)) {
    logStage("duplicate message, ignored", { msgId: msg.id });
    return null;
  }

  const est = await resolveInboundEstablishment(value);
  if (!est) {
    logStage("establishment not found or channel not connected", { msgId: msg.id });
    return null;
  }
  const contactName = value.contacts?.[0]?.profile?.name ?? null;
  const loaded = await loadConversation(est.id, inbound.from, contactName);
  const queued = await enqueueWhatsAppInboundJob({
    waMessageId: inbound.waMessageId,
    establishmentId: est.id,
    conversationId: loaded.conversation.id,
    whatsappPhoneNumberId: value.metadata.phone_number_id,
    value: value as unknown as Record<string, unknown>,
    message: msg as unknown as Record<string, unknown>,
  });
  if (queued.sequence === null) return null;
  return { establishmentId: est.id, conversationId: loaded.conversation.id };
}

export async function drainConversationInbox(establishmentId: string, conversationId: string): Promise<void> {
  const leaseId = await tryAcquireConversationProcessingLease(establishmentId, conversationId);
  if (!leaseId) {
    const orphaned = await quarantineOrphanWhatsAppInboundJobs(establishmentId, conversationId);
    if (orphaned > 0) logStage("orphan inbound jobs quarantined", { establishmentId, conversationId, count: orphaned });
    logStage("conversation already being processed, durable inbox retained", { establishmentId, conversationId });
    return;
  }
  try {
    for (;;) {
      const jobs = await listWhatsAppInboundJobs(establishmentId, conversationId);
      if (jobs.length === 0) {
        if (await releaseConversationProcessingLeaseIfDrained(establishmentId, conversationId, leaseId)) return;
        await quarantineWhatsAppInboundSequenceGap(establishmentId, conversationId, leaseId);
        logStage("inbound sequence gap quarantined", { establishmentId, conversationId });
        return;
      }
      for (const job of jobs) {
        if (Number(job.nextAttemptAt ?? 0) > Date.now()) {
          await releaseConversationProcessingLease(establishmentId, conversationId, leaseId);
          return;
        }
        // Um owner que expirou, foi substituído ou revogado por handoff para
        // antes de tocar no próximo job. O job permanece durável para o novo
        // owner; nunca é marcado como concluído por um turno obsoleto.
        if (!(await renewConversationProcessingLease(establishmentId, conversationId, leaseId, {
          allowNonAutomatedStatus: true,
        }))) return;
        try {
          await processQueuedMessage(job, leaseId);
        } catch (error) {
          const terminal = error instanceof OutboundReconciliationRequiredError ||
            error instanceof OutboundIntentConflictError ||
            error instanceof WhatsAppChannelGenerationError;
          const result = await failWhatsAppInboundJob(job, leaseId, inboundFailureCode(error), { terminal });
          console.error("PIPELINE THROW:", error);
      logStage("inbound job failed", {
            establishmentId,
            conversationId,
            outcome: result,
            errorCode: inboundFailureCode(error),
          });
          if (result === "retry_scheduled") {
            await releaseConversationProcessingLease(establishmentId, conversationId, leaseId);
            return;
          }
          if (result === "lease_lost") return;
          continue;
        }
        if (!(await completeWhatsAppInboundJob(job, leaseId))) return;
      }
    }
  } catch (error) {
    // O job continua no inbox. Libera o owner para que o cron ou a próxima
    // mensagem possa recuperá-lo sem esperar o TTL inteiro.
    await releaseConversationProcessingLease(establishmentId, conversationId, leaseId);
    throw error;
  }
}

async function processQueuedMessage(job: WhatsAppInboundJob, leaseId: string): Promise<void> {
  const value = job.value as unknown as WebhookValue;
  const msg = job.message as unknown as MetaInboundMessage;
  if (!value.metadata?.phone_number_id) return;
  const inbound = parseInboundMessage(msg);
  if (!inbound.from) return;

  // O tenant foi resolvido e validado ANTES do enqueue. Recovery deve confiar
  // nessa identidade durável, não resolver novamente o phone_number_id: o
  // número pode ter sido desconectado ou reassociado desde o recebimento, e
  // isso jamais pode mover uma mensagem antiga para outro estabelecimento.
  const est = await getEstablishment(job.establishmentId);
  if (!est) {
    logStage("queued establishment no longer exists", { msgId: msg.id, estId: job.establishmentId });
    return;
  }
  const currentPhoneNumberId = est.whatsapp?.phoneNumberId;
  if (currentPhoneNumberId && currentPhoneNumberId !== job.whatsappPhoneNumberId) {
    throw new WhatsAppChannelGenerationError();
  }
  const testCredentials = getWhatsappTestCredentials();
  const usesTestCredentials = Boolean(testCredentials &&
    testCredentials.establishmentId === est.id &&
    testCredentials.phoneNumberId === job.whatsappPhoneNumberId);
  if (!usesTestCredentials && est.whatsapp?.status !== "connected") {
    throw new Error("whatsapp_channel_not_connected");
  }
  logStage("establishment resolved", { msgId: msg.id, estId: est.id });

  // No caminho de teste, est.whatsapp pode não existir (ou estar
  // "connecting") — resolveSendCredentials() ignora esse valor por completo
  // quando as envs de teste estão presentes, então este placeholder nunca é
  // usado de fato para autenticar; só satisfaz o tipo.
  const wa: EstablishmentWhatsapp =
    est.whatsapp ?? { wabaId: "", phoneNumberId: "", status: "connecting", pin: { ciphertext: "", iv: "", authTag: "" } };

  const contactPhone = inbound.from;
  const contactName = value.contacts?.[0]?.profile?.name ?? null;
  let customerText = inbound.text;
  let persistedMedia: MessageMedia | undefined = inbound.media;
  let attachment: MessageAttachment | undefined;
  let transcription: MessageTranscription | undefined;

  // Marca como lida (feedback visual pro cliente).
  if (inbound.waMessageId) await markAsRead(wa, est.id, inbound.waMessageId);

  const { conversation, history } = await loadConversation(est.id, contactPhone, contactName);

  let prospectingContext: import("@/types").ProspectingContext | undefined;
  {
    const normalizedContactPhone = normalizePhone(contactPhone);
    if (normalizedContactPhone) {
      const session = await import("@/lib/repo").then(m => m.getProspectingSessionByPhone(est.id, normalizedContactPhone));
      if (session) {
        const now = Date.now();
        const isTerminal = 
          session.status === "NOT_INTERESTED" ||
          session.status === "HUMAN" ||
          session.status === "CLOSED" ||
          session.status === "EXPIRED" ||
          session.status === "OPTED_OUT";

        if (!isTerminal) {
          if (now > session.expiresAt) {
            await import("@/lib/repo").then(m => m.transitionProspectingSession(est.id, normalizedContactPhone, { action: "expire" }, now));
          } else {
            let activeSession = session;
            if (session.status === "PREPARED" || session.status === "WAITING_REPLY") {
              const updated = await import("@/lib/repo").then(m => m.transitionProspectingSession(est.id, normalizedContactPhone, { action: "receive_reply" }, now));
              if (updated) activeSession = updated;
            }
            prospectingContext = {
              leadId: activeSession.leadId,
              normalizedPhone: activeSession.normalizedPhone,
              businessName: activeSession.businessName,
              segment: activeSession.segment,
              initialManualMessage: activeSession.initialManualMessage,
              preRevealReplyCount: activeSession.preRevealReplyCount ?? 0,
              status: activeSession.status,
              preparedAt: activeSession.preparedAt,
              manualSendConfirmedAt: activeSession.manualSendConfirmedAt,
              firstReplyAt: activeSession.firstReplyAt,
              revealedAt: activeSession.revealedAt,
              expiresAt: activeSession.expiresAt,
            };
          }
        }
      }
    }
  }
  const canContinueAutomation = () => renewConversationProcessingLease(est.id, conversation.id, leaseId);
  const automationFence = { conversationId: conversation.id, leaseId };
  const outboundContext = (allowedStatuses: Array<"bot" | "handoff" | "closed"> = ["bot"], prospectingAction?: any) => ({
    jobId: job.id,
    leaseId,
    whatsappPhoneNumberId: job.whatsappPhoneNumberId,
    allowedStatuses,
    ...(prospectingAction ? { prospectingAction } : {}),
  });

  const existingOutbound = await getWhatsAppOutboundIntent(job.id);
  if (existingOutbound?.state === "confirmed") {
    await appendMessage(est.id, conversation.id, "bot", existingOutbound.text, existingOutbound.waMessageId ?? undefined);
    if (existingOutbound.prospectingAction) {
      if (existingOutbound.prospectingAction.action === "increment_pre_reveal") {
        await import("@/lib/repo").then(m => m.incrementProspectingPreRevealCount(est.id, contactPhone, job.id));
      } else {
        await import("@/lib/repo").then(m => m.transitionProspectingSession(est.id, contactPhone, existingOutbound.prospectingAction));
      }
    }
    return;
  }
  if (existingOutbound?.state === "reconciliation_required") {
    throw new OutboundReconciliationRequiredError(existingOutbound.lastErrorCode ?? "outbound_reconciliation_required");
  }

  // CAMPANHAS-07: qualquer mensagem inbound aceita (texto, áudio, mídia) pode
  // ser resposta a uma campanha — roda ANTES de qualquer branch/early-return
  // abaixo para nunca ser pulado, e nunca pode afetar o fluxo normal da
  // Lívia: correlação e persistência ficam isoladas em campaignRecipients,
  // nunca tocam conversation/customerProfile, e uma falha aqui nunca impede
  // a resposta ao cliente.
  try {
    await correlateCampaignReply(est.id, contactPhone);
  } catch (err) {
    console.error("[livia webhook] campaign reply correlation failed", {
      errorType: err instanceof Error ? err.name : "unknown",
    });
  }

  // Imagem/documento são anexos para atendimento humano, nunca entrada
  // multimodal da IA. O arquivo vai ao Storage privado e a mensagem recebe
  // só metadata + referência tenant-scoped. Em qualquer falha, a mensagem
  // ainda é persistida sem anexo para não desaparecer da conversa.
  if (inbound.kind === "image" || inbound.kind === "document") {
    const startedAt = Date.now();
    try {
      const mediaId = inbound.media?.metaMediaId;
      const waMessageId = inbound.waMessageId;
      if (!mediaId) throw new WhatsAppMediaError("missing_media_id");
      if (!waMessageId) throw new AttachmentStorageError("invalid_storage_scope");

      const downloaded = await downloadWhatsAppMedia(wa, est.id, mediaId, inbound.kind);
      attachment = await storeConversationAttachment({
        establishmentId: est.id,
        conversationId: conversation.id,
        waMessageId,
        metaMediaId: mediaId,
        type: inbound.kind,
        mimeType: downloaded.mimeType,
        filename: inbound.media?.filename,
        bytes: downloaded.bytes,
      });
      persistedMedia = {
        ...inbound.media,
        mimeType: downloaded.mimeType,
        fileSizeBytes: downloaded.sizeBytes,
        storageRef: attachment.storageRef,
      };

      try {
        await appendMessage(est.id, conversation.id, "customer", inbound.text, inbound.waMessageId, {
          kind: inbound.kind,
          phoneNumberId: value.metadata.phone_number_id,
          media: persistedMedia,
          attachment,
        });
      } catch (err) {
        await deleteConversationAttachment(est.id, conversation.id, attachment.storageRef);
        const { storageRef: _removedStorageRef, ...mediaWithoutStorageRef } = persistedMedia;
        persistedMedia = mediaWithoutStorageRef;
        attachment = undefined;
        throw err;
      }

      logStage("attachment stored", {
        msgId: msg.id,
        estId: est.id,
        sourceType: inbound.kind,
        sizeBytes: downloaded.sizeBytes,
        mimeType: downloaded.mimeType,
        durationMs: Date.now() - startedAt,
      });
      return;
    } catch (err) {
      await appendMessage(est.id, conversation.id, "customer", inbound.text, inbound.waMessageId, {
        kind: inbound.kind,
        phoneNumberId: value.metadata.phone_number_id,
        ...(persistedMedia ? { media: persistedMedia } : {}),
      });
      logStage("attachment processing failed", {
        msgId: msg.id,
        estId: est.id,
        sourceType: inbound.kind,
        errorCode: attachmentErrorCode(err),
        ...(err instanceof WhatsAppMediaError && err.status !== undefined ? { httpStatus: err.status } : {}),
        durationMs: Date.now() - startedAt,
      });
      return;
    }
  }

  // Áudio vira texto ANTES de entrar no pipeline conversacional. O binário
  // fica apenas em memória durante download/transcrição; o histórico recebe
  // o transcript limpo e os metadados mínimos ligados ao wamid original.
  if (inbound.kind === "audio") {
    const startedAt = Date.now();
    try {
      const mediaId = inbound.media?.metaMediaId;
      if (!mediaId) throw new WhatsAppMediaError("missing_media_id");
      logStage("audio processing started", { msgId: msg.id, estId: est.id, sourceType: "audio" });

      const downloaded = await downloadWhatsAppAudio(wa, est.id, mediaId);
      persistedMedia = {
        ...inbound.media,
        mimeType: downloaded.mimeType,
        fileSizeBytes: downloaded.sizeBytes,
      };
      logStage("audio download succeeded", {
        msgId: msg.id,
        estId: est.id,
        sourceType: "audio",
        sizeBytes: downloaded.sizeBytes,
        mimeType: downloaded.mimeType,
      });

      const result = await transcribeAudio({ bytes: downloaded.bytes, mimeType: downloaded.mimeType });
      customerText = result.text;
      transcription = {
        status: "completed",
        text: result.text,
        provider: result.provider,
        model: result.model,
        updatedAt: Date.now(),
      };
      logStage("audio transcription succeeded", {
        msgId: msg.id,
        estId: est.id,
        sourceType: "audio",
        transcriptLength: result.text.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const errorCode = audioErrorCode(err);
      transcription = { status: "failed", errorCode, updatedAt: Date.now() };
      await appendMessage(est.id, conversation.id, "customer", inbound.text, inbound.waMessageId, {
        kind: inbound.kind,
        phoneNumberId: value.metadata.phone_number_id,
        ...(persistedMedia ? { media: persistedMedia } : {}),
        transcription,
      });
      logStage("audio processing failed", {
        msgId: msg.id,
        estId: est.id,
        sourceType: "audio",
        errorCode,
        ...(err instanceof WhatsAppMediaError && err.status !== undefined ? { httpStatus: err.status } : {}),
        durationMs: Date.now() - startedAt,
      });

      // Falha de transcrição não pode furar as guardas já existentes: em
      // handoff/human a Lívia permanece em silêncio e apenas mantém a fila
      // humana atualizada. Uma conta suspensa conserva o fallback comercial
      // já usado pelo fluxo textual, sem revelar o erro técnico de áudio.
      if (est.status !== "active") {
        if (!warnedServicePausedRecently(history, Date.now())) {
          await replyAndLog(wa, est, conversation.id, contactPhone, SERVICE_PAUSED_REPLY, false, msg.id, outboundContext());
        }
        return;
      }
      if (conversation.status === "human" || conversation.status === "handoff") {
        await upsertPendingTask(est.id, conversation.id, contactPhone, {
          type: "awaiting_human",
          waitingFor: "responder mensagem nova do cliente",
        });
        return;
      }
      if (conversation.status === "closed" && conversation.closedReason === "automated_recipient") return;

      // A transcrição falhou: texto é deliberadamente a resposta mais segura.
      await replyAndLog(wa, est, conversation.id, contactPhone, AUDIO_FAILURE_REPLY, false, msg.id, outboundContext());
      return;
    }
  }

  // Registra a mensagem do cliente. Acontece ANTES de qualquer decisão de
  // parar o fluxo (estabelecimento inativo, handoff, humano no controle):
  // "a Livia não responde" nunca pode significar "a mensagem sumiu".
  const persistedCustomer = await appendMessage(est.id, conversation.id, "customer", customerText, inbound.waMessageId, {
    kind: inbound.kind,
    phoneNumberId: value.metadata.phone_number_id,
    ...(persistedMedia ? { media: persistedMedia } : {}),
    ...(attachment ? { attachment } : {}),
    ...(transcription ? { transcription } : {}),
  });

  // Imagem/documento e demais tipos continuam apenas reconhecidos e
  // persistidos. Não há visão, OCR, parser de documento nem conteúdo
  // inventado. Áudio transcrito segue abaixo exatamente como texto.
  if (inbound.kind !== "text" && inbound.kind !== "audio") {
    logStage("non-text message persisted without AI", { msgId: msg.id, type: inbound.kind });
    return;
  }

  // Uma oferta de humano não interrompe a Lívia. Só um pedido explícito ou
  // uma confirmação inequívoca, enquanto a oferta ainda está pendente, pode
  // mudar `bot` para `handoff`.
  if (conversation.status === "bot" && conversation.awaitingHumanOfferConfirmation) {
    const humanIntent = readHumanIntent(customerText);
    const confirmation = readConfirmation(customerText);
    const accepted = humanIntent === "asks" || confirmation === "yes" || acceptsHumanOffer(customerText);
    const declined = humanIntent === "declines" || confirmation === "no";

    if (accepted) {
      const transitioned = await transitionConversationStatusWithLease(est.id, conversation.id, leaseId, "bot", "handoff");
      if (!transitioned) return;
      await setAwaitingHumanOfferConfirmation(est.id, conversation.id, false);
      await upsertPendingTask(est.id, conversation.id, contactPhone, {
        type: "awaiting_human",
        waitingFor: "atendimento humano",
      });
      // Este é o único envio que nasce da própria transição para handoff.
      // Ele pode atravessar "handoff" (a confirmação seria impossível de
      // outra forma), mas nunca um humano que tenha assumido em seguida.
      await replyAndLog(wa, est, conversation.id, contactPhone, "Certo! Vou chamar uma pessoa da equipe para te ajudar por aqui.", shouldReplyWithVoice(inbound.kind, est), msg.id, outboundContext(["handoff"]));
      logStage("customer accepted human offer, handoff started", {
        msgId: msg.id,
        estId: est.id,
        conversationId: conversation.id,
      });
      return;
    }

    // A recusa e qualquer nova demanda do cliente encerram o contexto da
    // oferta. Isso impede que um "sim" de outro assunto, numa mensagem futura,
    // seja interpretado como aceite humano fora de contexto.
    await setAwaitingHumanOfferConfirmation(est.id, conversation.id, false, automationFence);
    if (declined) {
      logStage("customer declined human offer, Livia continuing", {
        msgId: msg.id,
        estId: est.id,
        conversationId: conversation.id,
      });
    }
  }

  // Uma conversa fechada por outro bot fica silenciosa até receber uma
  // demanda humana inequívoca. A classificação é determinística; nunca
  // chamamos a IA apenas para decidir se o bloqueio deve cair.
  const closureIntent = detectIntent(customerText);
  if (conversation.status === "closed") {
    if (conversation.closedReason === "automated_recipient") {
      if (declaresAutomatedRecipient(customerText) || !isClearHumanDemand(customerText, closureIntent)) {
        logStage("closed automated recipient, message only logged", {
          msgId: msg.id,
          estId: est.id,
          conversationId: conversation.id,
        });
        return;
      }
    } else if (isPureSocialFarewell(customerText)) {
      logStage("closed social conversation, farewell ignored", {
        msgId: msg.id,
        estId: est.id,
        conversationId: conversation.id,
      });
      return;
    }

    await reopenConversation(est.id, conversation.id);
    conversation.status = "bot";
  }

  // Estabelecimento comercialmente inativo (Establishment.status
  // "suspended"). Antes disto o webhook simplesmente retornava e o cliente
  // final ficava no silêncio absoluto — ele não tem relação nenhuma com o
  // SaaS e não tem como saber que algo parou.
  //
  // A resposta é neutra de propósito: nada sobre trial, assinatura,
  // cobrança ou pagamento, e nada que exponha a Livia como fornecedora. É
  // uma causa COMERCIAL — distinta de canal desconectado (tratado acima,
  // tecnicamente sem caminho de resposta) e de erro técnico (que continua
  // subindo para o catch do POST, sem virar "conta inativa").
  if (est.status !== "active") {
    if (!warnedServicePausedRecently(history, Date.now())) {
      await replyAndLog(wa, est, conversation.id, contactPhone, SERVICE_PAUSED_REPLY, shouldReplyWithVoice(inbound.kind, est), msg.id, outboundContext());
    }
    return;
  }

  // A transição é atômica. Só o vencedor pode enviar a despedida final; uma
  // reentrega ou outro webhook concorrente fica silencioso sem tocar a IA.
  if (declaresAutomatedRecipient(customerText)) {
    const wonClosure = await tryCloseAutomatedConversation(est.id, conversation.id);
    if (!wonClosure) {
      logStage("automated recipient already closed, no reply", {
        msgId: msg.id,
        estId: est.id,
        conversationId: conversation.id,
      });
      return;
    }

    await resolvePendingTask(est.id, conversation.id);
    await replyAndLog(wa, est, conversation.id, contactPhone, "Entendido! Vou encerrar por aqui. Até mais!", shouldReplyWithVoice(inbound.kind, est), msg.id, outboundContext(["closed"]));
    logStage("automated recipient detected, conversation closed", {
      msgId: msg.id,
      estId: est.id,
      conversationId: conversation.id,
    });
    return;
  }

  // Conversa com humano OU aguardando humano (handoff): a Livia fica quieta —
  // não atropela o atendente nem continua respondendo depois de identificar
  // que precisa de humano. A mensagem do cliente já foi persistida acima.
  //
  // O que faltava: só ficar quieta criava um beco sem saída. Ao clicar em
  // "Assumir conversa" o painel resolve a pendência (PATCH assume, em
  // app/api/conversations/[id]/route.ts) e a conversa passa a "human" — a
  // partir daí toda mensagem nova do cliente caía neste return sem deixar
  // rastro nenhum na fila de pendências, e a caixa de entrada classificava a
  // conversa como "Sem pendência" enquanto o cliente continuava escrevendo.
  //
  // Agora cada mensagem nova durante handoff/human reabre a MESMA pendência
  // (doc id = conversationId, ver lib/repo.ts: upsertPendingTask — não cria
  // fila paralela nem duplica documento), então a conversa volta a aparecer
  // como "Precisa de humano".
  //
  // ---- Caminho de volta pelo WhatsApp (06/09/2026) ----
  //
  // Faltava o cliente poder DESISTIR. A Livia oferecia atendente, gravava o
  // handoff no mesmo turno, e a partir daí ficava muda: o cliente que
  // respondia "não" nunca mais era atendido, e a única saída era o botão
  // "Devolver para Livia" no painel — que ele não tem. Foi exatamente o que
  // aconteceu em Production, e o cliente escreveu "vc ja chamou atendimento
  // humano msm eu dizendo q nao".
  //
  // A distinção que torna isso seguro já existia nos estados:
  //   "handoff" = a Livia parou, mas NINGUÉM assumiu -> voltar é seguro;
  //   "human"   = um atendente assumiu -> NUNCA voltar, tem gente digitando.
  //
  // Só uma recusa determinística retoma (ver lib/ai/humanRequest.ts), e um
  // "não" seco só conta quando a mensagem anterior da Livia era mesmo uma
  // oferta de atendente. Na dúvida, nada muda.
  if (conversation.status === "handoff") {
    const ultimaDaLivia = [...history].reverse().find((m) => m.role === "bot");
    const recusa =
      readHumanIntent(customerText) === "declines" ||
      (readConfirmation(customerText) === "no" && Boolean(ultimaDaLivia && offeredHuman(ultimaDaLivia.text)));

    if (recusa) {
      logStage("customer declined human handoff, Livia resuming", {
        msgId: msg.id,
        estId: est.id,
        conversationId: conversation.id,
      });
      const resumed = await transitionConversationStatusWithLease(est.id, conversation.id, leaseId, "handoff", "bot");
      if (!resumed) return;
      await resolvePendingTask(est.id, conversation.id, automationFence);
      conversation.status = "bot";
    }
  }

  if (conversation.status === "human" || conversation.status === "handoff") {
    logStage("conversation not handled by Livia (human/handoff), message only logged", {
      msgId: msg.id,
      estId: est.id,
      conversationId: conversation.id,
      status: conversation.status,
    });
    await upsertPendingTask(est.id, conversation.id, contactPhone, {
      type: "awaiting_human",
      waitingFor: "responder mensagem nova do cliente",
    });
    return;
  }

  // Não reabre o ciclo para uma despedida que veio depois de uma resposta
  // conclusiva, desde que não exista task nem pendência aberta.
  const lastBotMessage = [...history].reverse().find((message) => message.role === "bot");
  if (
    !conversation.task &&
    isPureSocialFarewell(customerText) &&
    Boolean(lastBotMessage && isClearClosingReply(lastBotMessage.text))
  ) {
    const pendingTask = await getPendingTask(est.id, conversation.id);
    if (!pendingTask || pendingTask.status === "resolved") {
      await closeConversation(est.id, conversation.id, "social_farewell");
      logStage("social farewell after clear closure, no reply", {
        msgId: msg.id,
        estId: est.id,
        conversationId: conversation.id,
      });
      return;
    }
  }

  // A conversa carregada no início do webhook pode estar defasada: outro
  // processamento pode ter identificado um destinatário automatizado e
  // fechado o contexto enquanto este seguia pelos caminhos normais. Releia
  // antes de qualquer continuação que possa atender ou responder. Isto não
  // substitui serialização distribuída, mas impede o fluxo já fechado antes
  // deste ponto de chegar a lembrete, IA, ferramentas ou sendText.
  const authoritativeConversation = await getConversation(est.id, conversation.id);
  if (
    authoritativeConversation?.status === "closed" &&
    authoritativeConversation.closedReason === "automated_recipient"
  ) {
    logStage("automated recipient closed before continuing, no reply", {
      msgId: msg.id,
      estId: est.id,
      conversationId: conversation.id,
    });
    return;
  }

  // Resposta ao lembrete de agendamento (anti-no-show). Só age quando existe
  // um agendamento que JÁ recebeu lembrete e ainda aguarda confirmação —
  // assim "sim"/"ok" no meio de outra conversa não é confundido.
  const intent = confirmCancelReminderIntent(customerText);
  if (intent) {
    if (!(await canContinueAutomation())) {
      logStage("automation discarded after handoff before reminder action", { msgId: msg.id, estId: est.id, conversationId: conversation.id });
      return;
    }
    const next = await findNextAppointment(est.id, normalizePhone(contactPhone));
    if (next && next.reminderSentAt && (next.status === "pending" || next.status === "confirmed")) {
      if (intent === "confirm") {
        await setStatus(est.id, next.id, "confirmed", automationFence, `wa-reminder:${job.id}:confirmed`);
      } else {
        await setStatus(est.id, next.id, "cancelled", automationFence, `wa-reminder:${job.id}:cancelled`);
      }
      // A alteração da agenda já aconteceu. ConversationTask representa um
      // trabalho ainda em andamento e não pode sobreviver a esse fato — nem
      // mesmo se uma etapa posterior (como o envio da resposta) falhar.
      await setConversationTask(est.id, conversation.id, null, automationFence);
      if (intent === "confirm") {
        await replyAndLog(wa, est, conversation.id, contactPhone, "Perfeito, agendamento confirmado! Te esperamos. 😊", shouldReplyWithVoice(inbound.kind, est), msg.id, outboundContext());
      } else {
        await replyAndLog(wa, est, conversation.id, contactPhone, "Tudo bem, seu horário foi cancelado. Quando quiser remarcar, é só chamar!", shouldReplyWithVoice(inbound.kind, est), msg.id, outboundContext());
      }
      // Confirmar/cancelar o lembrete resolve qualquer pendência que essa
      // conversa tivesse (Passo 9) — tipicamente "cliente confirmar o
      // horário", que é exatamente o que acabou de acontecer.
      await resolvePendingTask(est.id, conversation.id, automationFence);
      return;
    }
  }

  const kb = await getKnowledgeBase(est.id);
  const historyForAI = [
    // Em recuperação pós-crash, a mensagem pode já existir no histórico.
    // Remove-a antes de anexar a versão corrente: exatamente uma ocorrência,
    // sempre na posição cronológica do job que o owner está drenando.
    ...history.filter((message) => message.waMessageId !== inbound.waMessageId),
    { id: persistedCustomer.id, role: "customer" as const, text: customerText, at: persistedCustomer.at, waMessageId: inbound.waMessageId },
  ];

  // Fase 3 (determinística, sem custo de IA) + Fase 1: carregados ANTES da
  // IA para virarem contexto do prompt (fonte de verdade sobre o cliente e
  // sobre em que etapa da tarefa a conversa está — Fase 4/5).
  const detectedIntent = closureIntent;
  const storedProfile = await getCustomerProfile(est.id, contactPhone);
  // Identidade: o nome pode já existir no sistema mesmo sem estar no perfil —
  // o contato pode não ter nome público no WhatsApp (contactName null), mas
  // ter dado o nome ao agendar. Sem esta resolução, a Livia perguntava de
  // novo o nome de um cliente que ela já conhecia. Só busca nos agendamentos
  // quando não há nome em lugar nenhum, então não pesa no caminho comum.
  const knownName =
    storedProfile?.name ??
    contactName ??
    (await findCustomerNameFromAppointments(est.id, contactPhone));
  // O nome resolvido tem que chegar ao prompt já nesta mensagem — inclusive
  // quando ainda não existe documento de perfil (primeira conversa de um
  // cliente que já tinha agendamento).
  const customerProfile: CustomerProfile | null =
    storedProfile?.name || !knownName
      ? storedProfile
      : { ...(storedProfile ?? emptyProfile(est.id, contactPhone)), name: knownName };
  const existingTask: ConversationTask | null = conversation.task ?? null;

  if (isSilentAcknowledgement(customerText, detectedIntent, existingTask, history)) {
    logStage("silent acknowledgement, no reply", { msgId: msg.id, estId: est.id, conversationId: conversation.id });
    return;
  }

  logStage("invoking AI", { msgId: msg.id, estId: est.id, conversationId: conversation.id, intent: detectedIntent.type });
  // Lê o estado do carrinho DEPOIS de persistir a mensagem. O brain só recebe
  // a autorização estrutural para confirmar quando existe um resumo pendente;
  // texto do modelo não pode fabricar pedido, versão ou confirmação.
  const activeOrder = est.bot.ordersEnabled
    ? await (await import("@/lib/orders")).getActiveOrder(est.id, normalizePhone(contactPhone))
    : null;
  const orderAwaitingConfirmation = activeOrder?.status === "awaiting_confirmation"
    ? { orderId: activeOrder.id, version: activeOrder.version }
    : null;
  let brainResult: Awaited<ReturnType<typeof think>>;
  try {
    brainResult = await think({
      est,
      kb,
      history: historyForAI,
      contactPhone,
      contactName,
      customerProfile,
      prospectingContext,
      task: existingTask,
      intent: detectedIntent,
      hasLastConfirmedOrder: Boolean(conversation.lastConfirmedOrderId),
      orderAwaitingConfirmation,
      canContinueAutomation,
      automationFence: { conversationId: conversation.id, leaseId },
      operationIdScope: job.id,
    });
  } catch (err) {
    // A IA falhou (ex.: OpenAI fora do ar, erro de execução de ferramenta).
    // Sem isto, o erro subia genérico até o catch do POST e o log não dizia
    // em qual etapa exatamente a mensagem morreu.
    logStage("AI call failed", {
      msgId: msg.id,
      estId: est.id,
      conversationId: conversation.id,
      errorType: err instanceof Error ? err.name : "unknown",
    });
    throw err;
  }
  if (brainResult.abortedForHandoff || !(await canContinueAutomation())) {
    logStage("AI response discarded because human handoff won during processing", {
      msgId: msg.id,
      estId: est.id,
      conversationId: conversation.id,
    });
    return;
  }
  const {
    reply,
    handoff,
    booked,
    rescheduled,
    cancelled,
    agendaMutationCompleted,
    toolCalls,
    prospectingStatusTransition,
    pendingCancelAppointmentId,
    statedDate,
    statedService,
  } = brainResult;
  logStage("AI responded", {
    msgId: msg.id,
    estId: est.id,
    conversationId: conversation.id,
    replyLength: reply.length,
    handoff,
  });

  // Inclui confirm_appointment. Os flags legados continuam no fallback para
  // manter compatibilidade com dublês/testes e com qualquer chamador antigo
  // de BrainResult, mas a prova autoritativa nova vem da mutação real.
  const operationCompleted = Boolean(agendaMutationCompleted || booked || rescheduled || cancelled);

  // A agenda foi alterada dentro de think(), antes do envio ao WhatsApp.
  // Limpa a task assim que o fato é conhecido: uma falha de envio não pode
  // ressuscitar um fluxo que já terminou nem bloquear o próximo "ok".
  if (operationCompleted) {
    await setConversationTask(est.id, conversation.id, null, automationFence);
  }

  // `handoff` vindo do cérebro ainda pode significar apenas que a IA ofereceu
  // ajuda humana para uma situação fora do escopo. Handoff imediato só é
  // autorizado quando o cliente o pediu explicitamente nesta mensagem.
  const explicitHumanRequest = readHumanIntent(customerText) === "asks";
  const awaitingHumanOfferConfirmation = handoff && !explicitHumanRequest;
  const replyToSend = awaitingHumanOfferConfirmation
    ? "Posso chamar uma pessoa da equipe para te ajudar com isso?"
    : reply;

    let prospectingAction: any = null;
  if (prospectingContext && prospectingContext.status !== "EXPIRED") {
    if (handoff || explicitHumanRequest) {
      prospectingAction = { action: "set_outcome", status: "HUMAN" };
    } else if (prospectingStatusTransition) {
      if (prospectingStatusTransition === "REVEALED") prospectingAction = { action: "reveal" };
      else if (prospectingStatusTransition === "OPTED_OUT") prospectingAction = { action: "opt_out" };
      else prospectingAction = { action: "set_outcome", status: prospectingStatusTransition };
    } else if (prospectingContext.status === "LIVIA_ACTIVE") {
      prospectingAction = { action: "increment_pre_reveal" };
    }
  }

  let sent: { waMessageId?: string; text: string } | null;
  try {
    // A resposta textual ja e definitiva; a entrega so escolhe o canal e
    // nunca volta a chamar IA, ferramentas ou mutacoes.
    sent = await deliverFinalReply(wa, est, conversation.id, contactPhone, replyToSend, shouldReplyWithVoice(inbound.kind, est), msg.id, outboundContext(["bot"], prospectingAction));
  } catch (err) {
    // A resposta foi gerada mas não chegou ao cliente — a falha mais grave
    // possível aqui, e a que este log existe especificamente para não deixar
    // silenciosa. sendText já lança em qualquer status HTTP não-2xx da Graph
    // API (ver lib/whatsapp/client.ts); antes disto o erro só aparecia como
    // "[livia webhook] erro:" genérico, indistinguível de uma falha da IA.
    logStage("WhatsApp send failed", {
      msgId: msg.id,
      estId: est.id,
      conversationId: conversation.id,
      errorType: err instanceof Error ? err.name : "unknown",
    });
    throw err;
  }
  if (!sent) {
    logStage("AI response discarded because handoff won before delivery", {
      msgId: msg.id,
      estId: est.id,
      conversationId: conversation.id,
    });
    return;
  }
  logStage("WhatsApp send ok", { msgId: msg.id, estId: est.id, conversationId: conversation.id });
  await appendMessage(est.id, conversation.id, "bot", sent.text, sent.waMessageId);
  if (prospectingAction) {
    if (prospectingAction.action === "increment_pre_reveal") {
      await import("@/lib/repo").then(m => m.incrementProspectingPreRevealCount(est.id, contactPhone, job.id));
    } else {
      await import("@/lib/repo").then(m => m.transitionProspectingSession(est.id, contactPhone, prospectingAction));
    }
  }

  if (!(await canContinueAutomation())) return;

  // Fase 4: deriva e persiste o próximo estado da tarefa a partir do que a
  // IA realmente fez nesta rodada — nunca do que ela disse que faria.
  const nextTask = deriveTaskState({
    existingTask,
    intent: detectedIntent,
    toolCalls,
    booked: operationCompleted,
    // O dia que o cliente disse nesta mensagem, resolvido por código — é o
    // que faz a PRÓXIMA mensagem ("as 16", sem repetir o dia) usar a data
    // certa, em vez de herdar a que o modelo escolheu numa chamada anterior.
    statedDate,
    // O serviço que o cliente nomeou nesta mensagem — pelo mesmo motivo, para
    // a próxima mensagem ("as 17") não herdar um serviço preso de antes (OT-02G).
    statedService,
  });
  await setConversationIntent(est.id, conversation.id, detectedIntent.type, automationFence);
  // Guarda o agendamento que está aguardando confirmação de cancelamento, pra
  // que o "sim" da próxima mensagem cancele o ID EXATO — nunca "o próximo".
  const taskToPersist =
    nextTask && pendingCancelAppointmentId
      ? { ...nextTask, collectedData: { ...nextTask.collectedData, appointmentId: pendingCancelAppointmentId } }
      : nextTask;
  // Quando a operação concluiu, a task já foi limpa antes do envio. Evita um
  // segundo update e, sobretudo, não deixa o lifecycle depender do WhatsApp.
  if (!operationCompleted) {
    await setConversationTask(est.id, conversation.id, taskToPersist, automationFence);
  }

  // Fase 1: só campos determinísticos — nome do cartão de contato do
  // WhatsApp, intenção do classificador, e o serviço de um agendamento
  // REALMENTE criado agora (nunca um palpite da IA sobre o que o cliente
  // quer).
  const bookedServiceName = booked
    ? (toolCalls.find((t) => t.name === "create_appointment" && typeof t.args.serviceName === "string")?.args
        .serviceName as string | undefined)
    : undefined;
  await upsertCustomerProfile(est.id, contactPhone, {
    // `knownName` inclui o nome recuperado de um agendamento existente, então
    // a identidade passa a viver no perfil e a busca acima não se repete nas
    // próximas mensagens. Continua sendo dado determinístico (o próprio
    // cliente informou ao agendar), nunca inferência da IA.
    name: knownName ?? undefined,
    lastIntent: detectedIntent.type,
    lastService: bookedServiceName,
  }, automationFence);

  if (awaitingHumanOfferConfirmation) {
    await setAwaitingHumanOfferConfirmation(est.id, conversation.id, true, automationFence);
  } else if (handoff) {
    // "handoff" != "human": a Livia identificou que precisa de atendente e
    // PAROU de responder sozinha, mas ninguém assumiu ainda — só um clique
    // em "Assumir conversa" em /painel/conversas vira "human" de verdade.
    // TODO: notificar o dono/atendente (push, e-mail ou painel).
  }

  // Passo 9: registra/atualiza/conclui a pendência desta conversa,
  // integrada ao Intent (Passo 3) e ao ConversationTask (Passo 4) já
  // calculados acima — nunca uma pendência nova por mensagem, o documento é
  // reaproveitado (id = conversationId, ver lib/repo.ts).
  const pendingDraft = derivePendingTask({
    intent: detectedIntent,
    handoffActive: handoff && !awaitingHumanOfferConfirmation,
    task: nextTask,
    operationCompleted,
  });
  if (pendingDraft) {
    await upsertPendingTask(est.id, conversation.id, contactPhone, pendingDraft, automationFence);
  } else {
    await resolvePendingTask(est.id, conversation.id, automationFence);
  }

  // Fase 2: resumo só nos momentos relevantes (handoff ou uma operação de
  // agendamento concluída) — nunca a cada mensagem, pelo custo de mais uma
  // chamada de IA.
  if ((handoff && !awaitingHumanOfferConfirmation) || operationCompleted) {
    const summary = await summarizeConversation(contactName, historyForAI, {
      kind: handoff ? "handoff" : "booked",
    });
    if (summary) await setConversationSummary(est.id, conversation.id, summary, automationFence);
  }
  if (handoff && !awaitingHumanOfferConfirmation) {
    await transitionConversationStatusWithLease(est.id, conversation.id, leaseId, "bot", "handoff");
  }
}

async function replyAndLog(
  wa: EstablishmentWhatsapp,
  establishment: Establishment,
  conversationId: string,
  toPhone: string,
  text: string,
  preferVoice: boolean,
  msgId: string | undefined,
  outbound: {
    jobId: string;
    leaseId: string;
    whatsappPhoneNumberId: string;
    allowedStatuses: Array<"bot" | "handoff" | "closed">;
    prospectingAction?: any;
  },
): Promise<void> {
  const sent = await deliverFinalReply(wa, establishment, conversationId, toPhone, text, preferVoice, msgId, outbound);
  if (!sent) return;
  await appendMessage(establishment.id, conversationId, "bot", sent.text, sent.waMessageId);
}

function shouldReplyWithVoice(kind: string, establishment: Establishment): boolean {
  return kind === "audio" && Boolean(establishment.bot.voiceRepliesEnabled);
}

function voiceDeliveryErrorCode(error: unknown): string {
  if (error instanceof WhatsAppAudioSendError) return error.code;
  if (error instanceof SpeechError) return error.code === "invalid_audio" ? "tts_invalid_audio" : "tts_failed";
  // Erros não tipados aqui acontecem antes de uma confirmação de POST /messages.
  // sendAudio classifica toda falha de rede daquele POST como ambígua.
  return "audio_send_failed";
}

// Único ponto de entrega das respostas finais ao cliente. Recebe um texto já
// decidido: não chama think(), tools, transcrição nem muda estado de negócio.
async function deliverFinalReply(
  wa: EstablishmentWhatsapp,
  establishment: Establishment,
  conversationId: string,
  toPhone: string,
  text: string,
  preferVoice: boolean,
  msgId: string | undefined,
  outbound: {
    jobId: string;
    leaseId: string;
    whatsappPhoneNumberId: string;
    allowedStatuses: Array<"bot" | "handoff" | "closed">;
    prospectingAction?: any;
  },
): Promise<{ waMessageId?: string; text: string } | null> {
  const context = { ...(msgId ? { msgId } : {}), estId: establishment.id, conversationId };
  let audio: Awaited<ReturnType<typeof synthesizeSpeech>> | null = null;
  if (preferVoice) {
    try {
    logStage("TTS started", { ...context, textLength: text.length });
      audio = await synthesizeSpeech(text);
    logStage("TTS completed", {
      ...context,
        provider: audio.provider,
        model: audio.model,
        voice: audio.voice,
        sizeBytes: audio.bytes.length,
    });
    } catch (error) {
      logStage("voice fallback to text", { ...context, errorCode: voiceDeliveryErrorCode(error) });
    }
  }

  return executeDurableWhatsAppOutbound({
    jobId: outbound.jobId,
    establishmentId: establishment.id,
    conversationId,
    leaseId: outbound.leaseId,
    allowedStatuses: outbound.allowedStatuses,
    toPhone,
    whatsappPhoneNumberId: outbound.whatsappPhoneNumberId,
    text,
    preferVoice: Boolean(audio),
    ...(outbound.prospectingAction ? { prospectingAction: outbound.prospectingAction } : {}),
  }, async () => {
    if (!audio) return sendText(wa, establishment.id, toPhone, text);
    try {
      logStage("WhatsApp audio upload/send started", context);
      const sent = await sendAudio(wa, establishment.id, toPhone, audio.bytes, audio.mimeType);
      logStage("WhatsApp audio upload/send completed", context);
      return sent;
    } catch (error) {
      const safeTextFallback = error instanceof WhatsAppAudioSendError && error.safeTextFallback;
      if (!safeTextFallback) throw error;
      logStage("voice fallback to text", { ...context, errorCode: voiceDeliveryErrorCode(error) });
      return sendText(wa, establishment.id, toPhone, text);
    }
  }, (error) => {
    if (error instanceof WhatsAppTextSendError) return { code: error.code, ambiguous: error.code === "text_send_ambiguous" };
    if (error instanceof WhatsAppAudioSendError) return { code: error.code, ambiguous: error.code === "audio_send_ambiguous" };
    return { code: error instanceof Error ? error.name : "outbound_unknown_error", ambiguous: true };
  });
}

// ---- Tipos do payload do webhook da Meta (parcial, só o que usamos) ----
interface MetaStatusError {
  code?: number;
  title?: string;
  message?: string;
}
interface MetaStatusUpdate {
  id?: string;
  status?: string;
  errors?: MetaStatusError[];
}
interface WebhookValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string } }[];
  messages?: MetaInboundMessage[];
  statuses?: MetaStatusUpdate[];
}
interface WebhookBody {
  entry?: {
    changes?: {
      value?: WebhookValue;
    }[];
  }[];
}

// Perfil mínimo em memória para quando a identidade é conhecida (via
// agendamento) mas o documento de CustomerProfile ainda não existe. Nunca é
// gravado assim — a persistência acontece pelo upsertCustomerProfile normal.
function emptyProfile(establishmentId: string, phone: string): CustomerProfile {
  const now = Date.now();
  return {
    phone: normalizePhone(phone),
    establishmentId,
    name: null,
    preferredProfessional: null,
    preferredTime: null,
    frequentAddress: null,
    lastService: null,
    lastIntent: null,
    notes: null,
    lastInteractionAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
