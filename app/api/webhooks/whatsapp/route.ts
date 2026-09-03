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
import { findNextAppointment, setStatus } from "@/lib/scheduling";
import { normalizePhone } from "@/lib/whatsapp/client";
import type { Establishment, EstablishmentWhatsapp, ConversationTask } from "@/types";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const mode = p.get("hub.mode");
  const token = p.get("hub.verify_token");
  const challenge = p.get("hub.challenge");
  if (mode === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "verificação inválida" }, { status: 403 });
}

// Valida X-Hub-Signature-256 (sha256=<hmac do corpo cru com META_APP_SECRET>).
function verifySignature(rawBody: string, header: string | null): boolean {
  // .trim() aqui é defensivo: valores colados manualmente numa env var (ex.
  // via prompt interativo do `vercel env add`) podem carregar um espaço ou
  // quebra de linha extra no final, o que quebraria o HMAC silenciosamente
  // sem nenhum erro visível — só a assinatura nunca batendo.
  const secret = process.env.META_APP_SECRET?.trim();
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const provided = header.slice("sha256=".length);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  // Assinatura ausente/inválida/não confere -> ignora (responde 200 mesmo
  // assim para a Meta não desativar o webhook por erros repetidos).
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ received: true });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    return NextResponse.json({ received: true });
  }

  try {
    await handleWebhook(body);
  } catch (err) {
    console.error("[livia webhook] erro:", err);
  }
  // Sempre 200 pra Meta não desativar/reenviar o webhook.
  return NextResponse.json({ received: true });
}

async function handleWebhook(body: WebhookBody): Promise<void> {
  const change = body.entry?.[0]?.changes?.[0];
  const value = change?.value;
  const msg = value?.messages?.[0];
  // Ignora eventos que não são mensagem de entrada (ex.: status de entrega).
  if (!msg || !value?.metadata?.phone_number_id) return;

  // Só tratamos texto por enquanto (áudio/imagem/localização virão depois).
  if (msg.type !== "text" || !msg.text?.body) return;

  // Dedupe de reentrega.
  if (msg.id && (await alreadyProcessed(msg.id))) return;

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
    if (!est) return;
  } else {
    est = await findEstablishmentByPhoneNumberId(value.metadata.phone_number_id);
    if (!est || !est.whatsapp || est.whatsapp.status !== "connected") return;
  }
  if (est.status !== "active") return;

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

  // Registra a mensagem do cliente.
  await appendMessage(est.id, conversation.id, "customer", customerText, msg.id);

  // Se a conversa já está com humano OU aguardando humano (handoff), o bot
  // fica quieto — não atropela o atendente nem continua respondendo depois
  // de identificar que precisa de humano.
  if (conversation.status === "human" || conversation.status === "handoff") return;

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
  const customerProfile = await getCustomerProfile(est.id, contactPhone);
  const existingTask: ConversationTask | null = conversation.task ?? null;

  const { reply, handoff, booked, rescheduled, cancelled, toolCalls } = await think({
    est,
    kb,
    history: historyForAI,
    contactPhone,
    contactName,
    customerProfile,
    task: existingTask,
    intent: detectedIntent,
  });

  const sent = await sendText(wa, est.id, contactPhone, reply);
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
  await setConversationTask(est.id, conversation.id, nextTask);

  // Fase 1: só campos determinísticos — nome do cartão de contato do
  // WhatsApp, intenção do classificador, e o serviço de um agendamento
  // REALMENTE criado agora (nunca um palpite da IA sobre o que o cliente
  // quer).
  const bookedServiceName = booked
    ? (toolCalls.find((t) => t.name === "create_appointment" && typeof t.args.serviceName === "string")?.args
        .serviceName as string | undefined)
    : undefined;
  await upsertCustomerProfile(est.id, contactPhone, {
    name: contactName ?? undefined,
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
  const confirm = ["sim", "confirmo", "confirmar", "confirmado", "confirma", "ok", "isso", "pode confirmar", "vou sim", "com certeza", "👍"];
  const cancel = ["cancelar", "cancela", "cancelado", "nao vou", "não vou", "desmarcar", "desmarca", "nao poderei", "não poderei"];
  if (cancel.some((w) => t.includes(w))) return "cancel";
  if (confirm.some((w) => t === w || t.startsWith(w + " ") || t.includes(w))) return "confirm";
  return null;
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
interface WebhookBody {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { profile?: { name?: string } }[];
        messages?: {
          id?: string;
          from: string;
          type: string;
          text?: { body: string };
        }[];
      };
    }[];
  }[];
}
