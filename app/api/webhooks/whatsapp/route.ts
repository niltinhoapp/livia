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
  getKnowledgeBase,
  loadConversation,
  appendMessage,
  setConversationStatus,
  alreadyProcessed,
} from "@/lib/repo";
import { sendText, markAsRead } from "@/lib/whatsapp/client";
import { think } from "@/lib/ai/brain";
import { findNextAppointment, setStatus } from "@/lib/scheduling";
import { normalizePhone } from "@/lib/whatsapp/client";
import type { Establishment } from "@/types";

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
  const secret = process.env.META_APP_SECRET;
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

  const est = await findEstablishmentByPhoneNumberId(
    value.metadata.phone_number_id,
  );
  if (!est || !est.whatsapp || est.whatsapp.status !== "connected") return;
  if (est.status !== "active") return;

  const contactPhone = msg.from;
  const contactName = value.contacts?.[0]?.profile?.name ?? null;
  const customerText = msg.text.body;

  // Marca como lida (feedback visual pro cliente).
  if (msg.id) await markAsRead(est.whatsapp, msg.id);

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
        await replyAndLog(est, conversation.id, contactPhone, "Perfeito, agendamento confirmado! Te esperamos. 😊");
      } else {
        await setStatus(est.id, next.id, "cancelled");
        await replyAndLog(est, conversation.id, contactPhone, "Tudo bem, seu horário foi cancelado. Quando quiser remarcar, é só chamar!");
      }
      return;
    }
  }

  const kb = await getKnowledgeBase(est.id);
  const historyForAI = [
    ...history,
    { id: msg.id ?? "cur", role: "customer" as const, text: customerText, at: Date.now() },
  ];

  const { reply, handoff } = await think({
    est,
    kb,
    history: historyForAI,
    contactPhone,
    contactName,
  });

  const sent = await sendText(est.whatsapp, contactPhone, reply);
  await appendMessage(est.id, conversation.id, "bot", reply, sent.waMessageId);

  if (handoff) {
    // "handoff" != "human": a Livia identificou que precisa de atendente e
    // PAROU de responder sozinha, mas ninguém assumiu ainda — só um clique
    // em "Assumir conversa" em /painel/conversas vira "human" de verdade.
    await setConversationStatus(est.id, conversation.id, "handoff");
    // TODO: notificar o dono/atendente (push, e-mail ou painel).
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
  est: Establishment,
  conversationId: string,
  toPhone: string,
  text: string,
): Promise<void> {
  const sent = await sendText(est.whatsapp!, toPhone, text);
  await appendMessage(est.id, conversationId, "bot", text, sent.waMessageId);
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
