// Repositório: leitura/escrita das coleções do Firestore.
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { establishmentRef, sub, db } from "@/lib/firebase/admin";
import { normalizePhone } from "@/lib/whatsapp/client";
import { generateRandomPin, encryptPin, decryptPin } from "@/lib/whatsapp/tokenCrypto";
import type {
  Establishment,
  EstablishmentType,
  EncryptedToken,
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
        ownerUid: id, // establishmentId = uid do dono autenticado (1 estabelecimento por conta)
        status: "active",
        createdAt: Date.now(),
        bot: data.bot ?? defaultBotConfig(),
      };
  await establishmentRef(id).set(merged, { merge: true });
  return merged;
}

// TTL da lease exclusiva de uma tentativa de conexão de WhatsApp. A lease só
// é assumida dentro do POST /api/whatsapp/connect — ou seja, DEPOIS que o
// estabelecimento já concluiu o popup do Embedded Signup e o frontend já
// enviou code/wabaId/phoneNumberId. O TTL não cobre o tempo de interação no
// popup (isso já passou); cobre o processamento no backend (exchange,
// verificação de posse, subscribe, register, finalize) e o cenário de uma
// requisição travada/lenta ou um processo que caiu no meio do caminho — 8
// minutos dá folga bem acima do tempo normal dessas chamadas (segundos) sem
// deixar uma tentativa travada bloqueando reconexão por muito tempo.
// Centralizado aqui — se precisar ajustar, é o único lugar.
export const WHATSAPP_CONNECT_LEASE_TTL_MS = 8 * 60 * 1000;

export type ClaimWhatsappResult =
  // Claim nova: ninguém estava conectando/conectado — o PIN já foi gerado e
  // persistido cifrado (status "connecting") DENTRO desta transação, antes
  // de retornar. attemptId é a prova de posse da lease: só quem recebeu
  // este valor pode finalizar ou liberar esta tentativa específica.
  | { outcome: "claimed"; pin: string; attemptId: string }
  // Havia uma claim "connecting" para o MESMO wabaId/phoneNumberId com a
  // lease JÁ EXPIRADA (tentativa anterior não concluiu a tempo, ou foi
  // liberada após uma falha) — reaproveita o PIN já persistido (nunca gera
  // outro) e assume uma lease NOVA com attemptId novo.
  | { outcome: "resumed"; pin: string; attemptId: string }
  // Já há uma conexão "connected" válida — não é sobrescrita.
  | { outcome: "already_connected" }
  // Há uma lease ATIVA (outra requisição em andamento agora) para o mesmo
  // estabelecimento, ou uma claim "connecting" (com ou sem lease ativa)
  // para OUTRO wabaId/phoneNumberId — recusa por segurança, nunca sobrepõe.
  | { outcome: "conflict" };

// Tenta assumir, com EXCLUSIVIDADE, o processo de conexão de WhatsApp de um
// estabelecimento. Duas requisições concorrentes nunca recebem "resumed"/
// "claimed" ao mesmo tempo: a lease (attemptId + leaseExpiresAt) garante que
// só uma tentativa por vez tem permissão de prosseguir, mesmo quando os
// wabaId/phoneNumberId informados são idênticos — a segunda cai em
// "conflict" enquanto a lease da primeira estiver ativa.
//
// Também é aqui, e não na rota, que o PIN nasce: gerado e cifrado dentro da
// própria transação, então a claim SÓ é considerada bem-sucedida se o PIN
// cifrado já estiver gravado no Firestore — nunca depois de chamar /register.
export async function claimWhatsappConnection(
  id: string,
  wabaId: string,
  phoneNumberId: string,
): Promise<ClaimWhatsappResult> {
  const ref = establishmentRef(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as Establishment).whatsapp : undefined;
    const now = Date.now();

    if (existing?.status === "connected") {
      return { outcome: "already_connected" as const };
    }

    if (existing?.status === "connecting") {
      const leaseActive =
        typeof existing.leaseExpiresAt === "number" && existing.leaseExpiresAt > now;

      // Lease ainda válida: ninguém mais assume, IDs iguais ou não.
      if (leaseActive) {
        return { outcome: "conflict" as const };
      }

      // Lease expirada (ou liberada após falha) — só retoma se for
      // exatamente a MESMA WABA/número da tentativa anterior; IDs
      // diferentes continuam em conflito mesmo sem lease ativa, para nunca
      // sobrescrever silenciosamente uma claim de outra tentativa.
      if (existing.wabaId !== wabaId || existing.phoneNumberId !== phoneNumberId) {
        return { outcome: "conflict" as const };
      }

      const attemptId = randomUUID();
      tx.update(ref, {
        "whatsapp.attemptId": attemptId,
        "whatsapp.leaseExpiresAt": now + WHATSAPP_CONNECT_LEASE_TTL_MS,
        "whatsapp.claimedAt": now,
      });
      return { outcome: "resumed" as const, pin: decryptPin(existing.pin), attemptId };
    }

    // Nova claim: nenhuma tentativa anterior para este estabelecimento.
    const pin = generateRandomPin();
    const attemptId = randomUUID();
    const whatsapp = {
      wabaId,
      phoneNumberId,
      status: "connecting" as const,
      pin: encryptPin(pin),
      attemptId,
      claimedAt: now,
      leaseExpiresAt: now + WHATSAPP_CONNECT_LEASE_TTL_MS,
    };
    if (snap.exists) {
      tx.update(ref, { whatsapp });
    } else {
      // Conta nova que ainda não passou pelo painel/config — cria o doc
      // mínimo do estabelecimento junto (mesmo padrão do
      // upsertEstablishmentConfig), já com a claim.
      const base: Establishment = {
        id,
        name: "",
        type: "outro",
        ownerUid: id,
        status: "active",
        createdAt: now,
        bot: defaultBotConfig(),
        whatsapp,
      };
      tx.set(ref, base);
    }
    return { outcome: "claimed" as const, pin, attemptId };
  });
}

// Conclui a conexão: chamada só depois que TODA a sequência obrigatória
// (exchange, verificação de posse, subscribe, register) já teve sucesso.
// Verifica, na MESMA transação, que a lease ainda pertence a este
// `attemptId` — se outra tentativa já assumiu (nossa lease expirou no meio
// do caminho e alguém mais tomou posse) ou a conexão já foi concluída por
// outro caminho, esta função recusa escrever "connected" e devolve
// `{ ok: false }`. Preserva o `pin` já persistido pela claim (nunca
// reescrito aqui); attemptId/leaseExpiresAt são removidos por não fazerem
// mais sentido depois de "connected".
export async function finalizeWhatsappConnection(
  id: string,
  attemptId: string,
  data: { wabaId: string; phoneNumberId: string; accessToken: EncryptedToken; registeredAt?: number },
): Promise<{ ok: boolean }> {
  const ref = establishmentRef(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as Establishment).whatsapp : undefined;

    if (!existing || existing.status !== "connecting" || existing.attemptId !== attemptId) {
      return { ok: false };
    }

    const now = Date.now();
    tx.update(ref, {
      "whatsapp.wabaId": data.wabaId,
      "whatsapp.phoneNumberId": data.phoneNumberId,
      "whatsapp.accessToken": data.accessToken,
      "whatsapp.status": "connected",
      "whatsapp.connectedAt": now,
      "whatsapp.tokenRefreshedAt": now,
      "whatsapp.attemptId": FieldValue.delete(),
      "whatsapp.leaseExpiresAt": FieldValue.delete(),
      ...(data.registeredAt !== undefined ? { "whatsapp.registeredAt": data.registeredAt } : {}),
    });
    return { ok: true };
  });
}

// Libera a lease de uma tentativa que falhou (exchange/ownership/subscribe/
// register) ANTES do TTL expirar naturalmente — permite uma nova tentativa
// imediata sem obrigar o estabelecimento a esperar. NUNCA apaga o `pin`
// cifrado nem move o status para longe de "connecting": o registro
// permanece recuperável, só a exclusividade é liberada (leaseExpiresAt
// jogado para o passado — a próxima claim com o MESMO wabaId/phoneNumberId
// entra pelo caminho de "resumed" e reaproveita o PIN).
//
// Verifica `attemptId` antes de liberar: se esta já não é mais a tentativa
// ativa (outra já assumiu, ou já finalizou), não faz nada — nunca libera
// uma lease que não é sua.
export async function releaseWhatsappConnectionAttempt(
  id: string,
  attemptId: string,
): Promise<void> {
  const ref = establishmentRef(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as Establishment).whatsapp : undefined;
    if (!existing || existing.status !== "connecting" || existing.attemptId !== attemptId) {
      return;
    }
    tx.update(ref, {
      "whatsapp.leaseExpiresAt": Date.now() - 1,
      "whatsapp.attemptId": FieldValue.delete(),
    });
  });
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

// Lista as conversas do estabelecimento pra tela /painel/conversas — mais
// recentes primeiro. `sub(establishmentId, ...)` já restringe à subcoleção
// do tenant, então não há risco de vazar conversa de outro estabelecimento.
export async function listConversations(
  establishmentId: string,
  limitCount = 50,
): Promise<Conversation[]> {
  const snap = await sub(establishmentId, "conversations")
    .orderBy("lastMessageAt", "desc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as Conversation);
}

export async function getConversation(
  establishmentId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const doc = await sub(establishmentId, "conversations").doc(conversationId).get();
  return doc.exists ? (doc.data() as Conversation) : null;
}

// Mensagens de uma conversa em ordem cronológica, pra exibir na tela (não
// confundir com o histórico deslizante usado pela IA em loadConversation).
export async function listMessages(
  establishmentId: string,
  conversationId: string,
  limitCount = 100,
): Promise<Message[]> {
  const snap = await sub(establishmentId, "conversations")
    .doc(conversationId)
    .collection("messages")
    .orderBy("at", "desc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as Message).reverse();
}

// Apaga TODAS as conversas (e suas mensagens) de UM estabelecimento — usado
// pela ferramenta de limpeza em /painel/conversas (ex.: preparar o painel
// pra gravação de vídeo). NUNCA faz exclusão global de collection: `sub()`
// já escopa tudo à subcoleção establishments/{establishmentId}/conversations,
// que é fisicamente separada da de qualquer outro tenant no Firestore — não
// há como isso vazar para outro estabelecimento. Não toca em appointments,
// meta/knowledge, schedule, whatsapp ou no doc do estabelecimento em si;
// só conversas + suas mensagens.
export async function clearConversations(
  establishmentId: string,
): Promise<{ deletedConversations: number; deletedMessages: number }> {
  const convsSnap = await sub(establishmentId, "conversations").get();

  let deletedConversations = 0;
  let deletedMessages = 0;

  for (const convDoc of convsSnap.docs) {
    const msgsSnap = await convDoc.ref.collection("messages").get();
    // Firestore aceita no máx. 500 operações por batch — 450 dá margem.
    for (let i = 0; i < msgsSnap.docs.length; i += 450) {
      const chunk = msgsSnap.docs.slice(i, i + 450);
      const batch = db.batch();
      chunk.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deletedMessages += chunk.length;
    }
    await convDoc.ref.delete();
    deletedConversations++;
  }

  return { deletedConversations, deletedMessages };
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
