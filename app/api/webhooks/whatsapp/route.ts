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
  getKnowledgeBase,
  loadConversation,
  appendMessage,
  setConversationStatus,
  setConversationIntent,
  setConversationTask,
  setConversationSummary,
  getCustomerProfile,
  upsertCustomerProfile,
  upsertPendingTask,
  resolvePendingTask,
  alreadyProcessed,
} from "@/lib/repo";
import { sendText, markAsRead } from "@/lib/whatsapp/client";
import { think } from "@/lib/ai/brain";
import { detectIntent } from "@/lib/ai/intent";
import { deriveTaskState } from "@/lib/ai/taskState";
import { derivePendingTask } from "@/lib/ai/pendingTask";
import { summarizeConversation } from "@/lib/ai/summarize";
import { SERVICE_PAUSED_REPLY, warnedServicePausedRecently } from "@/lib/servicePaused";
import { findNextAppointment, setStatus, findCustomerNameFromAppointments } from "@/lib/scheduling";
import { normalizePhone } from "@/lib/whatsapp/client";
import { readConfirmation } from "@/lib/ai/confirmation";
import type { Establishment, EstablishmentWhatsapp, ConversationTask, CustomerProfile } from "@/types";

// Log de diagnóstico do webhook — nunca inclui secret/token/telefone/texto da
// mensagem, só identificadores técnicos (message id da Meta, establishment
// id, conversation id, contagens, booleanos). Existe porque "POST 200" não
// prova que a mensagem foi processada: o caso real que motivou isto foi o
// webhook retornando 200 em ~8ms, sem nenhuma chamada externa — a assinatura
// estava falhando e ninguém sabia exatamente por quê (secret ausente? header
// ausente? assinatura não bate?), porque o retorno era idêntico nos três casos.
function logStage(stage: string, data?: Record<string, unknown>) {
  console.log(`[livia webhook] ${stage}`, data ? JSON.stringify(data) : "");
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
    logStage("payload parse failed", { error: String(err) });
    return NextResponse.json({ received: true });
  }

  try {
    await handleWebhook(body);
  } catch (err) {
    // Não silencioso: qualquer exceção não tratada por um passo específico
    // (ver os try/catch nomeados dentro de handleWebhook) cai aqui e fica
    // visível nos logs — nunca é engolida.
    console.error("[livia webhook] erro não tratado:", err);
  }
  // Sempre 200 pra Meta não desativar/reenviar o webhook.
  return NextResponse.json({ received: true });
}

async function handleWebhook(body: WebhookBody): Promise<void> {
  // A Meta pode enviar mais de um entry/change/message no mesmo POST (ex.:
  // duas mensagens do cliente em rápida sucessão chegam batched). O código
  // só olhava entry[0].changes[0].messages[0] — qualquer mensagem além dessa
  // era descartada em silêncio, sem log e sem erro. Processa todas, em ordem.
  const messages: { value: WebhookValue; msg: WebhookMessage }[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const msg of value?.messages ?? []) {
        messages.push({ value: value!, msg });
      }
    }
  }

  if (messages.length === 0) {
    // Evento real, mas não é mensagem de entrada — status de entrega/leitura,
    // ou qualquer outro tipo de change. Comportamento correto é ignorar; o
    // log é só para distinguir isto de "a mensagem sumiu antes de chegar aqui".
    logStage("no incoming message in payload", { entries: body.entry?.length ?? 0 });
    return;
  }

  logStage("messages in payload", { count: messages.length });
  for (const { value, msg } of messages) {
    await processMessage(value, msg);
  }
}

async function processMessage(value: WebhookValue, msg: WebhookMessage): Promise<void> {
  if (!value.metadata?.phone_number_id) {
    logStage("message without phone_number_id, ignored", { msgId: msg.id });
    return;
  }

  // Só tratamos texto por enquanto (áudio/imagem/localização virão depois).
  if (msg.type !== "text" || !msg.text?.body) {
    logStage("non-text message ignored", { msgId: msg.id, type: msg.type });
    return;
  }

  // Dedupe de reentrega.
  if (msg.id && (await alreadyProcessed(msg.id))) {
    logStage("duplicate message, ignored", { msgId: msg.id });
    return;
  }

  // TEMPORÁRIO (gravação do App Review, só Preview): se o phone_number_id
  // recebido é o número de teste da Meta, resolve direto pro estabelecimento
  // fixo de teste (nunca escreve nada no Firestore) e ignora o gate de
  // "connected" — só nesse caminho. Nenhuma das envs existe em Production,
  // então isTestPhoneNumber é sempre false lá e o comportamento não muda.
  // Remover após a gravação.
  const testPhoneNumberId = process.env.WHATSAPP_TEST_PHONE_NUMBER_ID;
  const testEstablishmentId = process.env.WHATSAPP_TEST_ESTABLISHMENT_ID;
  const isTestPhoneNumber =
    Boolean(testPhoneNumberId) && value.metadata.phone_number_id === testPhoneNumberId;

  let est: Establishment | null;
  if (isTestPhoneNumber && testEstablishmentId) {
    est = await getEstablishment(testEstablishmentId);
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

  const contactPhone = msg.from;
  const contactName = value.contacts?.[0]?.profile?.name ?? null;
  const customerText = msg.text.body;

  // Marca como lida (feedback visual pro cliente).
  if (msg.id) await markAsRead(wa, est.id, msg.id);

  const { conversation, history } = await loadConversation(
    est.id,
    contactPhone,
    contactName,
  );

  // Registra a mensagem do cliente. Acontece ANTES de qualquer decisão de
  // parar o fluxo (estabelecimento inativo, handoff, humano no controle):
  // "a Livia não responde" nunca pode significar "a mensagem sumiu".
  await appendMessage(est.id, conversation.id, "customer", customerText, msg.id);

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
  // como "Precisa de humano". A saída continua sendo explícita e manual:
  // "Devolver para Livia" no painel. Nenhum retorno automático — a Livia não
  // pode voltar a responder enquanto um atendente estiver no controle.
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

  // Resposta ao lembrete de agendamento (anti-no-show). Só age quando existe
  // um agendamento que JÁ recebeu lembrete e ainda aguarda confirmação —
  // assim "sim"/"ok" no meio de outra conversa não é confundido.
  const intent = confirmCancelIntent(customerText);
  if (intent) {
    const next = await findNextAppointment(est.id, normalizePhone(contactPhone));
    if (next && next.reminderSentAt && (next.status === "pending" || next.status === "confirmed")) {
      if (intent === "confirm") {
        await setStatus(est.id, next.id, "confirmed");
        await replyAndLog(wa, est.id, conversation.id, contactPhone, "Perfeito, agendamento confirmado! Te esperamos. 😊");
      } else {
        await setStatus(est.id, next.id, "cancelled");
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
  const detectedIntent = detectIntent(customerText);
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
    logStage("AI call failed", { msgId: msg.id, estId: est.id, conversationId: conversation.id, error: String(err) });
    throw err;
  }
  const { reply, handoff, booked, rescheduled, cancelled, toolCalls, pendingCancelAppointmentId } = brainResult;
  logStage("AI responded", {
    msgId: msg.id,
    estId: est.id,
    conversationId: conversation.id,
    replyLength: reply.length,
    handoff,
  });

  let sent: { waMessageId?: string };
  try {
    sent = await sendText(wa, est.id, contactPhone, reply);
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
      error: String(err),
    });
    throw err;
  }
  logStage("WhatsApp send ok", { msgId: msg.id, estId: est.id, conversationId: conversation.id });
  await appendMessage(est.id, conversation.id, "bot", reply, sent.waMessageId);

  // Passo 6: só uma operação com retorno positivo da FERRAMENTA conta como
  // concluída — nunca o texto da resposta. `booked`/`rescheduled`/`cancelled`
  // só chegam true a partir do resultado real de create/reschedule/cancel
  // (ver lib/ai/tools.ts + lib/ai/brain.ts).
  const operationCompleted = booked || rescheduled || cancelled;

  // Fase 4: deriva e persiste o próximo estado da tarefa a partir do que a
  // IA realmente fez nesta rodada — nunca do que ela disse que faria.
  const nextTask = deriveTaskState({
    existingTask,
    intent: detectedIntent,
    toolCalls,
    booked: operationCompleted,
  });
  await setConversationIntent(est.id, conversation.id, detectedIntent.type);
  // Guarda o agendamento que está aguardando confirmação de cancelamento, pra
  // que o "sim" da próxima mensagem cancele o ID EXATO — nunca "o próximo".
  const taskToPersist =
    nextTask && pendingCancelAppointmentId
      ? { ...nextTask, collectedData: { ...nextTask.collectedData, appointmentId: pendingCancelAppointmentId } }
      : nextTask;
  await setConversationTask(est.id, conversation.id, taskToPersist);

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

  if (handoff) {
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
    handoffActive: handoff,
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
  if (handoff || operationCompleted) {
    const summary = await summarizeConversation(contactName, historyForAI, {
      kind: handoff ? "handoff" : "booked",
    });
    if (summary) await setConversationSummary(est.id, conversation.id, summary);
  }
}

// Detecta intenção de confirmar/cancelar em respostas curtas ao lembrete.
function confirmCancelIntent(text: string): "confirm" | "cancel" | null {
  const t = text.trim().toLowerCase();
  if (t.length > 30) return null; // resposta longa: deixa a IA tratar

  // Pedido explícito de cancelamento em resposta ao lembrete — inalterado.
  const cancel = ["cancelar", "cancela", "cancelado", "nao vou", "não vou", "desmarcar", "desmarca", "nao poderei", "não poderei"];
  if (cancel.some((w) => t.includes(w))) return "cancel";

  // A confirmação de presença passa a usar o matcher seguro. A versão
  // anterior fazia `t.includes("isso")`, então "não é isso" era lido como
  // CONFIRMAÇÃO — uma negação confirmando presença. Só "yes" inequívoco age;
  // "no" e "unclear" devolvem null e a IA trata normalmente.
  return readConfirmation(t) === "yes" ? "confirm" : null;
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
interface WebhookMessage {
  id?: string;
  from: string;
  type: string;
  text?: { body: string };
}
interface WebhookValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string } }[];
  messages?: WebhookMessage[];
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
