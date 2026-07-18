// Repositório: leitura/escrita das coleções do Firestore.
import { establishmentRef, sub, db } from "@/lib/firebase/admin";
import { normalizePhone } from "@/lib/whatsapp/client";
import type {
  Establishment,
  EstablishmentType,
  BotConfig,
  KnowledgeBase,
  Conversation,
  Message,
  MessageRole,
} from "@/types";

export function defaultBotConfig(): BotConfig {
  return {
    personaName: "Livia",
    tone: "acolhedora e objetiva",
    bookingEnabled: false,
    handoffKeywords: ["falar com atendente", "atendente", "humano"],
    medicalGuardrail: false,
  };
}

export async function getEstablishment(id: string): Promise<Establishment | null> {
  const doc = await establishmentRef(id).get();
  return doc.exists ? (doc.data() as Establishment) : null;
}

// Cria (se novo) ou atualiza nome/tipo/config do bot do estabelecimento.
export async function upsertEstablishmentConfig(
  id: string,
  data: { name?: string; type?: EstablishmentType; bot?: BotConfig },
): Promise<Establishment> {
  const existing = await getEstablishment(id);
  const merged: Establishment = existing
    ? {
        ...existing,
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.bot !== undefined ? { bot: data.bot } : {}),
      }
    : {
        id,
        name: data.name ?? "",
        type: data.type ?? "outro",
        ownerUid: "", // TODO: preencher com o login quando existir
        status: "active",
        createdAt: Date.now(),
        bot: data.bot ?? defaultBotConfig(),
      };
  await establishmentRef(id).set(merged, { merge: true });
  return merged;
}

// Acha o estabelecimento dono de um phone_number_id (o webhook chega com ele).
// Query num campo aninhado exige índice; em produção, criar índice composto.
export async function findEstablishmentByPhoneNumberId(
  phoneNumberId: string,
): Promise<Establishment | null> {
  const snap = await db
    .collection("establishments")
    .where("whatsapp.phoneNumberId", "==", phoneNumberId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0]!.data() as Establishment;
}

export async function getKnowledgeBase(
  establishmentId: string,
): Promise<KnowledgeBase | null> {
  const doc = await sub(establishmentId, "meta").doc("knowledge").get();
  return doc.exists ? (doc.data() as KnowledgeBase) : null;
}

// Salva (merge) a base de conhecimento do estabelecimento.
export async function saveKnowledgeBase(
  establishmentId: string,
  data: Omit<KnowledgeBase, "establishmentId" | "updatedAt">,
): Promise<KnowledgeBase> {
  const kb: KnowledgeBase = {
    ...data,
    establishmentId,
    updatedAt: Date.now(),
  };
  await sub(establishmentId, "meta").doc("knowledge").set(kb);
  return kb;
}

// Recupera (ou cria) a conversa do contato e devolve as últimas mensagens
// pra dar contexto à IA.
export async function loadConversation(
  establishmentId: string,
  contactPhone: string,
  contactName: string | null,
  historyLimit = 12,
): Promise<{ conversation: Conversation; history: Message[] }> {
  const id = normalizePhone(contactPhone);
  const convRef = sub(establishmentId, "conversations").doc(id);
  const snap = await convRef.get();

  let conversation: Conversation;
  if (snap.exists) {
    conversation = snap.data() as Conversation;
  } else {
    conversation = {
      id,
      establishmentId,
      contactPhone: id,
      contactName,
      status: "bot",
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
    };
    await convRef.set(conversation);
  }

  const msgsSnap = await convRef
    .collection("messages")
    .orderBy("at", "desc")
    .limit(historyLimit)
    .get();
  const history = msgsSnap.docs
    .map((d) => d.data() as Message)
    .reverse(); // ordem cronológica

  return { conversation, history };
}

export async function appendMessage(
  establishmentId: string,
  conversationId: string,
  role: MessageRole,
  text: string,
  waMessageId?: string,
): Promise<void> {
  const convRef = sub(establishmentId, "conversations").doc(conversationId);
  const msgRef = convRef.collection("messages").doc();
  const msg: Message = {
    id: msgRef.id,
    role,
    text,
    at: Date.now(),
    ...(waMessageId ? { waMessageId } : {}),
  };
  await msgRef.set(msg);
  await convRef.update({ lastMessageAt: msg.at });
}

export async function setConversationStatus(
  establishmentId: string,
  conversationId: string,
  status: Conversation["status"],
): Promise<void> {
  await sub(establishmentId, "conversations")
    .doc(conversationId)
    .update({ status });
}

// Dedupe: a Meta reenvia webhooks. Guardamos os IDs já processados por
// alguns minutos pra não responder duas vezes à mesma mensagem.
export async function alreadyProcessed(waMessageId: string): Promise<boolean> {
  const ref = db.collection("_processed_wa_messages").doc(waMessageId);
  const snap = await ref.get();
  if (snap.exists) return true;
  await ref.set({ at: Date.now() });
  return false;
}
