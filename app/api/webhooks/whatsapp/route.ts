// Webhook do WhatsApp — o núcleo da Livia.
//
// GET  -> verificação (handshake com hub.challenge).
// POST -> recebe a mensagem do cliente, identifica o estabelecimento,
//         carrega base de conhecimento + histórico, chama a IA e responde.
//
// Responde 200 rápido em todos os casos pra Meta não reenviar; o processamento
// pesado (IA) roda antes do 200 porque o Vercel encerra a função ao retornar —
// para volumes maiores, mover para uma fila (Cloud Tasks), como no Nuvem Rush.
//
// Segurança: o POST valida a assinatura HMAC-SHA256 (X-Hub-Signature-256) com
// o META_APP_SECRET sobre o corpo cru — sem isso, qualquer um forjaria
// mensagens/eventos (ex.: confirmar ou cancelar agendamento de um cliente
// alheio). Mesmo padrão do webhook do Nuvem Rush.
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  findEstablishmentByPhoneNumberId,
  getEstablishment,
  getConversation,
  getKnowledgeBase,
  loadConversation,
  appendMessage,
  setConversationStatus,
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
} from "@/lib/repo";
import {
  sendText,
  markAsRead,
  downloadWhatsAppAudio,
  downloadWhatsAppMedia,
  WhatsAppMediaError,
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
import type {
  Establishment,
  EstablishmentWhatsapp,
  ConversationTask,
  CustomerProfile,
  MessageMedia,
  MessageAttachment,
  MessageTranscription,
} from "@/types";

const AUDIO_FAILURE_REPLY = "Não consegui entender esse áudio. Pode enviar novamente ou escrever a mensagem?";

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
    // visível nos logs — nunca é engolida.
    console.error("[livia webhook] erro não tratado", {
      errorType: err instanceof Error ? err.name : "unknown",
    });
  }
  // Sempre 200 pra Meta não desativar/reenviar webhook.
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
  for (const { value, msg } of messages) {
    // Um item inválido/falho não pode descartar os demais itens do mesmo
    // lote da Meta. O POST continua respondendo 200 pela estratégia atual.
    try {
      await processMessage(value, msg);
    } catch (err) {
      // Mantém a falha visível sem expor o conteúdo/identificadores da
      // mensagem e segue com os demais itens do mesmo lote.
      console.error("[livia webhook] message processing failed", {
        errorType: err instanceof Error ? err.name : "unknown",
      });
    }
  }
}

async function processMessage(value: WebhookValue, msg: MetaInboundMessage): Promise<void> {
  if (!value.metadata?.phone_number_id) {
    logStage("message without phone_number_id, ignored", { msgId: msg.id });
    return;
  }

  const inbound = parseInboundMessage(msg);
  if (!inbound.from) {
    logStage("message without sender, ignored", { msgId: msg.id });
    return;
  }

  // Dedupe de reentrega.
  if (inbound.waMessageId && (await alreadyProcessed(inbound.waMessageId))) {
    logStage("duplicate message, ignored", { msgId: msg.id });
    return;
  }

  // TEMPORÁRIO (gravação do App Review, só Preview): se o phone_number_id
  // recebido é o número de teste da Meta, resolve direto pro estabelecimento
  // fixo de teste e ignora o gate de "connected" — só nesse caminho. A guarda
  // centralizada bloqueia Production,
  // desenvolvimento local e ambiente desconhecido, mesmo se as envs existirem.
  // Remover após a gravação.
  const testCredentials = getWhatsappTestCredentials();
  const isTestPhoneNumber = testCredentials?.phoneNumberId === value.metadata.phone_number_id;

  let est: Establishment | null;
  if (isTestPhoneNumber && testCredentials) {
    est = await getEstablishment(testCredentials.establishmentId);
    if (!est) {
      logStage("test establishment not found", { msgId: msg.id });
      return;
    }
  } else {
    est = await findEstablishmentByPhoneNumberId(value.metadata.phone_number_id);
    // Causa TÉCNICA, não comercial: sem canal conectado não há como enviar
    // nada de volta. Continua sendo um return silencioso de propósito — não
    // existe caminho de resposta para avisar o cliente.
    if (!est || !est.whatsapp || est.whatsapp.status !== "connected") {
      logStage("establishment not found or channel not connected", {
        msgId: msg.id,
        found: Boolean(est),
        whatsappStatus: est?.whatsapp?.status ?? null,
      });
      return;
    }
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

  const { conversation, history } = await loadConversation(
    est.id,
    contactPhone,
    contactName,
  );

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
          await replyAndLog(wa, est.id, conversation.id, contactPhone, SERVICE_PAUSED_REPLY);
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

      await replyAndLog(wa, est.id, conversation.id, contactPhone, AUDIO_FAILURE_REPLY);
      return;
    }
  }

  // Registra a mensagem do cliente. Acontece ANTES de qualquer decisão de
  // parar o fluxo (estabelecimento inativo, handoff, humano no controle):
  // "a Livia não responde" nunca pode significar "a mensagem sumiu".
  await appendMessage(est.id, conversation.id, "customer", customerText, inbound.waMessageId, {
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
      await setAwaitingHumanOfferConfirmation(est.id, conversation.id, false);
      await setConversationStatus(est.id, conversation.id, "handoff");
      await upsertPendingTask(est.id, conversation.id, contactPhone, {
        type: "awaiting_human",
        waitingFor: "atendimento humano",
      });
      await replyAndLog(wa, est.id, conversation.id, contactPhone, "Certo! Vou chamar uma pessoa da equipe para te ajudar por aqui.");
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
    await setAwaitingHumanOfferConfirmation(est.id, conversation.id, false);
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
      await replyAndLog(wa, est.id, conversation.id, contactPhone, SERVICE_PAUSED_REPLY);
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
    await replyAndLog(wa, est.id, conversation.id, contactPhone, "Entendido! Vou encerrar por aqui. Até mais!");
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
      await setConversationStatus(est.id, conversation.id, "bot");
      await resolvePendingTask(est.id, conversation.id);
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
    const next = await findNextAppointment(est.id, normalizePhone(contactPhone));
    if (next && next.reminderSentAt && (next.status === "pending" || next.status === "confirmed")) {
      if (intent === "confirm") {
        await setStatus(est.id, next.id, "confirmed");
      } else {
        await setStatus(est.id, next.id, "cancelled");
      }
      // A alteração da agenda já aconteceu. ConversationTask representa um
      // trabalho ainda em andamento e não pode sobreviver a esse fato — nem
      // mesmo se uma etapa posterior (como o envio da resposta) falhar.
      await setConversationTask(est.id, conversation.id, null);
      if (intent === "confirm") {
        await replyAndLog(wa, est.id, conversation.id, contactPhone, "Perfeito, agendamento confirmado! Te esperamos. 😊");
      } else {
        await replyAndLog(wa, est.id, conversation.id, contactPhone, "Tudo bem, seu horário foi cancelado. Quando quiser remarcar, é só chamar!");
      }
      // Confirmar/cancelar o lembrete resolve qualquer pendência que essa
      // conversa tivesse (Passo 9) — tipicamente "cliente confirmar o
      // horário", que é exatamente o que acabou de acontecer.
      await resolvePendingTask(est.id, conversation.id);
      return;
    }
  }

  const kb = await getKnowledgeBase(est.id);
  const historyForAI = [
    ...history,
    { id: msg.id ?? "cur", role: "customer" as const, text: customerText, at: Date.now() },
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
  let brainResult: Awaited<ReturnType<typeof think>>;
  try {
    brainResult = await think({
      est,
      kb,
      history: historyForAI,
      contactPhone,
      contactName,
      customerProfile,
      task: existingTask,
      intent: detectedIntent,
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
  const {
    reply,
    handoff,
    booked,
    rescheduled,
    cancelled,
    agendaMutationCompleted,
    toolCalls,
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
    await setConversationTask(est.id, conversation.id, null);
  }

  // `handoff` vindo do cérebro ainda pode significar apenas que a IA ofereceu
  // ajuda humana para uma situação fora do escopo. Handoff imediato só é
  // autorizado quando o cliente o pediu explicitamente nesta mensagem.
  const explicitHumanRequest = readHumanIntent(customerText) === "asks";
  const awaitingHumanOfferConfirmation = handoff && !explicitHumanRequest;
  const replyToSend = awaitingHumanOfferConfirmation
    ? "Posso chamar uma pessoa da equipe para te ajudar com isso?"
    : reply;

  let sent: { waMessageId?: string };
  try {
    sent = await sendText(wa, est.id, contactPhone, replyToSend);
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
  logStage("WhatsApp send ok", { msgId: msg.id, estId: est.id, conversationId: conversation.id });
  await appendMessage(est.id, conversation.id, "bot", replyToSend, sent.waMessageId);

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
  await setConversationIntent(est.id, conversation.id, detectedIntent.type);
  // Guarda o agendamento que está aguardando confirmação de cancelamento, pra
  // que o "sim" da próxima mensagem cancele o ID EXATO — nunca "o próximo".
  const taskToPersist =
    nextTask && pendingCancelAppointmentId
      ? { ...nextTask, collectedData: { ...nextTask.collectedData, appointmentId: pendingCancelAppointmentId } }
      : nextTask;
  // Quando a operação concluiu, a task já foi limpa antes do envio. Evita um
  // segundo update e, sobretudo, não deixa o lifecycle depender do WhatsApp.
  if (!operationCompleted) {
    await setConversationTask(est.id, conversation.id, taskToPersist);
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
  });

  if (awaitingHumanOfferConfirmation) {
    await setAwaitingHumanOfferConfirmation(est.id, conversation.id, true);
  } else if (handoff) {
    // "handoff" != "human": a Livia identificou que precisa de atendente e
    // PAROU de responder sozinha, mas ninguém assumiu ainda — só um clique
    // em "Assumir conversa" em /painel/conversas vira "human" de verdade.
    await setConversationStatus(est.id, conversation.id, "handoff");
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
    await upsertPendingTask(est.id, conversation.id, contactPhone, pendingDraft);
  } else {
    await resolvePendingTask(est.id, conversation.id);
  }

  // Fase 2: resumo só nos momentos relevantes (handoff ou uma operação de
  // agendamento concluída) — nunca a cada mensagem, pelo custo de mais uma
  // chamada de IA.
  if ((handoff && !awaitingHumanOfferConfirmation) || operationCompleted) {
    const summary = await summarizeConversation(contactName, historyForAI, {
      kind: handoff ? "handoff" : "booked",
    });
    if (summary) await setConversationSummary(est.id, conversation.id, summary);
  }
}

async function replyAndLog(
  wa: EstablishmentWhatsapp,
  establishmentId: string,
  conversationId: string,
  toPhone: string,
  text: string,
): Promise<void> {
  const sent = await sendText(wa, establishmentId, toPhone, text);
  await appendMessage(establishmentId, conversationId, "bot", text, sent.waMessageId);
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
