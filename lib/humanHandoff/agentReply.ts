// Resposta do atendente humano enviada pelo painel. Só existe com a conversa
// assumida ("human"), vai pelo WhatsApp oficial do estabelecimento e entra no
// histórico com autoria "agent" — é esse histórico que a Lívia lê depois.
import { db, sub } from "@/lib/firebase/admin";
import { appendMessage, getConversation, getEstablishment } from "@/lib/repo";
import { sendText } from "@/lib/whatsapp/client";

export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export type AgentReplyResult =
  | { ok: true; messageId: string; duplicate: boolean }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string };

interface AgentSendClaim {
  status: "sending" | "sent" | "failed";
  at: number;
  messageId?: string;
}

export async function sendAgentReply(input: {
  establishmentId: string;
  conversationId: string;
  text: unknown;
  clientMessageId: unknown;
  now?: number;
}): Promise<AgentReplyResult> {
  const now = input.now ?? Date.now();
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > 4096) return { ok: false, status: 400, error: "Escreva uma mensagem de até 4096 caracteres." };
  const clientMessageId = typeof input.clientMessageId === "string" ? input.clientMessageId : "";
  if (!CLIENT_MESSAGE_ID.test(clientMessageId)) return { ok: false, status: 400, error: "identificador de envio inválido" };

  const conversation = await getConversation(input.establishmentId, input.conversationId);
  if (!conversation) return { ok: false, status: 404, error: "conversa não encontrada" };
  if (conversation.status !== "human") return { ok: false, status: 409, error: "Assuma o atendimento antes de responder por aqui." };
  const establishment = await getEstablishment(input.establishmentId);
  if (establishment?.whatsapp?.status !== "connected") return { ok: false, status: 409, error: "O WhatsApp do estabelecimento não está conectado." };
  if (!conversation.lastCustomerMessageAt || now - conversation.lastCustomerMessageAt > WHATSAPP_SERVICE_WINDOW_MS) {
    return { ok: false, status: 409, error: "O WhatsApp só permite responder até 24h depois da última mensagem do cliente." };
  }

  // Um toque duplo ou um retry do navegador não pode mandar a mesma resposta duas vezes.
  const claimRef = sub(input.establishmentId, "conversations").doc(input.conversationId).collection("agentSends").doc(clientMessageId);
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(claimRef);
    const existing = snap.exists ? (snap.data() as AgentSendClaim) : null;
    if (existing && existing.status !== "failed") return existing;
    tx.set(claimRef, { status: "sending", at: now } satisfies AgentSendClaim);
    return null;
  });
  if (claim?.status === "sent") return { ok: true, messageId: claim.messageId ?? clientMessageId, duplicate: true };
  if (claim?.status === "sending") return { ok: false, status: 409, error: "Esta mensagem já está sendo enviada." };

  let waMessageId: string | undefined;
  try {
    waMessageId = (await sendText(establishment.whatsapp, establishment.id, conversation.contactPhone, text)).waMessageId;
  } catch {
    await claimRef.set({ status: "failed", at: Date.now() } satisfies AgentSendClaim);
    return { ok: false, status: 502, error: "Não foi possível enviar pelo WhatsApp agora. Tente novamente." };
  }
  const message = await appendMessage(input.establishmentId, input.conversationId, "agent", text, waMessageId);
  await claimRef.set({ status: "sent", at: Date.now(), messageId: message.id } satisfies AgentSendClaim);
  return { ok: true, messageId: message.id, duplicate: false };
}
