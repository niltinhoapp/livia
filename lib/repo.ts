// Repositório: leitura/escrita das coleções do Firestore.
import { randomUUID } from "node:crypto";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { establishmentRef, sub, db } from "@/lib/firebase/admin";
import { normalizePhone } from "@/lib/whatsapp/client";
import { generateRandomPin, encryptPin, decryptPin } from "@/lib/whatsapp/tokenCrypto";
import type {
  Establishment,
  EstablishmentType,
  EstablishmentWhatsapp,
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

// Quantos documentos inspecionar ao procurar estabelecimentos que
// compartilham um phone_number_id ou uma WABA. Um mesmo número pode aparecer
// em mais de um documento — tipicamente porque tentativas de conexão
// anteriores o gravaram e ficaram para trás como "connecting"/"disconnected".
// Na prática são pouquíssimos; o teto existe só para a query nunca ser
// ilimitada.
const TENANT_LOOKUP_CANDIDATES = 10;

// PIN cifrado que este estabelecimento já tem para ESTE número, se houver.
//
// Lê primeiro o mapa por número; se não achar, aceita o campo legado `pin`
// — mas SOMENTE quando ele se refere ao mesmo número (documentos antigos
// guardavam um PIN único, sempre o do `phoneNumberId` corrente). Nunca
// devolve o PIN de um número para outro: registrar com PIN errado é
// exatamente o erro 133005.
function storedPinFor(
  wa: EstablishmentWhatsapp | undefined,
  phoneNumberId: string,
): EncryptedToken | undefined {
  const fromMap = wa?.pinsByPhoneNumberId?.[phoneNumberId];
  if (fromMap) return fromMap;
  if (wa?.pin && wa.phoneNumberId === phoneNumberId) return wa.pin;
  return undefined;
}

// Mapa de PINs com o deste número adicionado, preservando os já existentes.
// Preservar é o ponto: o cliente pode trocar de número e voltar ao anterior
// depois, e o número antigo continua exigindo o PIN antigo na Meta.
//
// Também recolhe o `pin` legado para dentro do mapa. Sem isso, uma troca de
// número perderia o PIN do formato antigo para sempre: a claim nova
// substitui o objeto `whatsapp` inteiro, e o campo legado sairia junto —
// exatamente o cenário que o mapa existe para evitar.
function pinsWith(
  wa: EstablishmentWhatsapp | undefined,
  phoneNumberId: string,
  pin: EncryptedToken,
): Record<string, EncryptedToken> {
  const pins: Record<string, EncryptedToken> = { ...(wa?.pinsByPhoneNumberId ?? {}) };
  if (wa?.pin && wa.phoneNumberId && !pins[wa.phoneNumberId]) {
    pins[wa.phoneNumberId] = wa.pin;
  }
  pins[phoneNumberId] = pin;
  return pins;
}

// Existe OUTRO estabelecimento (≠ selfId) já conectado neste phone_number_id?
//
// Dois estabelecimentos conectados no mesmo número deixam o roteamento do
// webhook ambíguo (ver findEstablishmentByPhoneNumberId) — as mensagens
// pertencem a um só dono e não há como desempatar corretamente depois. Por
// isso a checagem acontece ANTES de assumir a claim, e não como conserto.
//
// Filtra o status em memória de propósito: uma segunda cláusula de igualdade
// em campo aninhado poderia exigir índice composto, e uma query que falha
// aqui bloquearia conexões legítimas.
async function otherConnectedEstablishmentWithNumber(
  tx: Transaction,
  phoneNumberId: string,
  selfId: string,
): Promise<string | null> {
  const query = db
    .collection("establishments")
    .where("whatsapp.phoneNumberId", "==", phoneNumberId)
    .limit(TENANT_LOOKUP_CANDIDATES);
  const snap = await tx.get(query);
  const owner = snap.docs.find(
    (d) => d.id !== selfId && (d.data() as Establishment).whatsapp?.status === "connected",
  );
  return owner?.id ?? null;
}

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
  // O estabelecimento havia DESCONECTADO pelo painel e está reconectando o
  // MESMO número, que já tem PIN guardado — reaproveita esse PIN. É o que
  // torna desconectar/reconectar possível: um PIN novo seria recusado pela
  // Meta com 133005, porque a verificação em 2 etapas do número continua
  // valendo mesmo depois da desconexão.
  | { outcome: "reconnected"; pin: string; attemptId: string }
  // Outro estabelecimento já está conectado neste phone_number_id. Recusa
  // antes de assumir a claim — dois donos no mesmo número tornam o
  // roteamento do webhook ambíguo e sem conserto correto depois.
  | { outcome: "number_in_use" }
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
    // Leituras primeiro (exigência do Firestore: nenhuma leitura depois de
    // escrever na mesma transação).
    const numberOwner = await otherConnectedEstablishmentWithNumber(tx, phoneNumberId, id);
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as Establishment).whatsapp : undefined;
    const now = Date.now();

    // Número já pertence a outro estabelecimento conectado — recusa antes de
    // tocar em qualquer coisa.
    if (numberOwner) {
      return { outcome: "number_in_use" as const };
    }

    if (existing?.status === "connected") {
      return { outcome: "already_connected" as const };
    }

    // Reconexão do MESMO número depois de uma desconexão pelo painel:
    // reaproveita o PIN guardado para ele. Se (por dados antigos ou limpeza
    // manual) não houver PIN guardado, cai adiante na claim nova e gera um —
    // é a única opção possível, e um eventual 133005 aparece com diagnóstico
    // claro em vez de estourar aqui.
    if (existing?.status === "disconnected" && existing.phoneNumberId === phoneNumberId) {
      const saved = storedPinFor(existing, phoneNumberId);
      if (saved) {
        const attemptId = randomUUID();
        tx.update(ref, {
          "whatsapp.wabaId": wabaId,
          "whatsapp.status": "connecting",
          "whatsapp.attemptId": attemptId,
          "whatsapp.leaseExpiresAt": now + WHATSAPP_CONNECT_LEASE_TTL_MS,
          "whatsapp.claimedAt": now,
          // Migra o PIN legado para o mapa na primeira reconexão, sem perder
          // nenhum PIN já registrado para outros números.
          "whatsapp.pinsByPhoneNumberId": pinsWith(existing, phoneNumberId, saved),
          "whatsapp.disconnectedAt": FieldValue.delete(),
        });
        return { outcome: "reconnected" as const, pin: decryptPin(saved), attemptId };
      }
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

      // Sem PIN guardado para este número (documento antigo ou limpo
      // manualmente) não há o que retomar — cai na claim nova abaixo, que
      // gera um PIN.
      const saved = storedPinFor(existing, phoneNumberId);
      if (saved) {
        const attemptId = randomUUID();
        tx.update(ref, {
          "whatsapp.attemptId": attemptId,
          "whatsapp.leaseExpiresAt": now + WHATSAPP_CONNECT_LEASE_TTL_MS,
          "whatsapp.claimedAt": now,
          "whatsapp.pinsByPhoneNumberId": pinsWith(existing, phoneNumberId, saved),
        });
        return { outcome: "resumed" as const, pin: decryptPin(saved), attemptId };
      }
    }

    // Claim nova: primeira conexão do estabelecimento, ou troca para um
    // número diferente do que estava guardado.
    //
    // O mapa de PINs dos números ANTERIORES é preservado de propósito: este
    // update substitui o objeto `whatsapp` inteiro, e sem carregar o mapa
    // adiante o PIN do número antigo se perderia — impedindo o cliente de
    // voltar para ele depois (a Meta continuaria exigindo aquele PIN).
    const pin = generateRandomPin();
    const encryptedPin = encryptPin(pin);
    const attemptId = randomUUID();
    const whatsapp = {
      wabaId,
      phoneNumberId,
      status: "connecting" as const,
      pinsByPhoneNumberId: pinsWith(existing, phoneNumberId, encryptedPin),
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
// `{ ok: false }`. Preserva os PINs já persistidos pela claim (nunca
// reescritos aqui) — inclusive os de números anteriores, que continuam
// necessários se o cliente voltar para um deles; attemptId/leaseExpiresAt são
// removidos por não fazerem mais sentido depois de "connected".
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

// Algum OUTRO estabelecimento (≠ selfId) está conectado usando esta MESMA
// WABA? A inscrição de webhooks da Meta é por WABA, não por número — remover
// a inscrição por causa de uma desconexão derrubaria os webhooks de todos os
// outros números daquela WABA. Quem desconecta só pode desinscrever se a
// resposta aqui for `false`.
export async function hasOtherConnectedEstablishmentWithWaba(
  wabaId: string,
  selfId: string,
): Promise<boolean> {
  const snap = await db
    .collection("establishments")
    .where("whatsapp.wabaId", "==", wabaId)
    .limit(TENANT_LOOKUP_CANDIDATES)
    .get();
  return snap.docs.some(
    (d) => d.id !== selfId && (d.data() as Establishment).whatsapp?.status === "connected",
  );
}

export type DisconnectWhatsappResult =
  // Estava conectado e foi desconectado agora.
  | { outcome: "disconnected" }
  // Não havia conexão (nunca conectou, ou já estava desconectado) — tratado
  // como sucesso idempotente: um botão não deve dar erro por clique repetido.
  | { outcome: "already_disconnected" }
  // Há uma tentativa de conexão em andamento com lease ativa — desconectar
  // agora correria com o finalize dela.
  | { outcome: "in_progress" };

// Desconecta o WhatsApp do estabelecimento: a Livia para de enviar e de
// atender por aquele número, mas NADA do negócio é apagado.
//
// O que é preservado, e por quê:
//   - `pinsByPhoneNumberId` (e o `pin` legado): o PIN de 2 etapas pertence ao
//     NÚMERO na Meta e continua valendo depois da desconexão — sem ele, uma
//     reconexão futura geraria um PIN novo e a Meta recusaria com 133005;
//   - `wabaId`/`phoneNumberId`: identificam o número para reconectar depois e
//     permitem casar com o PIN certo. Manter o phoneNumberId aqui só é seguro
//     porque o webhook passou a exigir status "connected" (ver
//     findEstablishmentByPhoneNumberId);
//   - `registeredAt`: histórico de que a Livia registrou o número.
//
// O que sai: `accessToken` (a credencial em si — a reconexão emite outra) e os
// campos que descrevem uma conexão ativa. Conversas, mensagens, agenda e base
// de conhecimento vivem em subcoleções e não são tocadas.
//
// NÃO faz deregister do número na Meta: desconectar da Livia não pode
// desmontar a configuração de WhatsApp do cliente. A remoção da inscrição de
// webhooks é responsabilidade do chamador (precisa do accessToken e da guarda
// de WABA compartilhada) — ver app/api/whatsapp/disconnect/route.ts.
export async function disconnectWhatsapp(id: string): Promise<DisconnectWhatsappResult> {
  const ref = establishmentRef(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as Establishment).whatsapp : undefined;

    if (!existing || existing.status === "disconnected") {
      return { outcome: "already_disconnected" as const };
    }

    if (existing.status === "connecting") {
      const leaseActive =
        typeof existing.leaseExpiresAt === "number" && existing.leaseExpiresAt > Date.now();
      if (leaseActive) return { outcome: "in_progress" as const };
      // Lease expirada: é uma tentativa abandonada, não uma conexão viva.
      // Segue para a limpeza abaixo, que a encerra formalmente.
    }

    tx.update(ref, {
      "whatsapp.status": "disconnected",
      "whatsapp.disconnectedAt": Date.now(),
      "whatsapp.accessToken": FieldValue.delete(),
      "whatsapp.connectedAt": FieldValue.delete(),
      "whatsapp.tokenRefreshedAt": FieldValue.delete(),
      "whatsapp.attemptId": FieldValue.delete(),
      "whatsapp.leaseExpiresAt": FieldValue.delete(),
    });
    return { outcome: "disconnected" as const };
  });
}

// Acha o estabelecimento CONECTADO dono de um phone_number_id (o webhook
// chega com ele).
//
// O filtro por status é aplicado DEPOIS de buscar os candidatos, de
// propósito: uma segunda cláusula de igualdade em campo aninhado
// (whatsapp.status) poderia exigir um índice composto, e uma query que falha
// aqui derruba o atendimento inteiro — o webhook engole a exceção e a
// mensagem some. Buscar por phoneNumberId usa o índice de campo único que o
// Firestore já mantém sozinho, e a filtragem em memória sobre um punhado de
// documentos é irrelevante em custo.
//
// ANTES este método fazia `.limit(1)` e devolvia um documento QUALQUER com
// aquele número, deixando o webhook checar o status depois. Com dois
// estabelecimentos compartilhando o mesmo phone_number_id, o Firestore podia
// devolver o não conectado — e o webhook descartava a mensagem em silêncio,
// sem procurar o outro. Era não determinístico: a mesma conta podia receber
// ou perder mensagens entre requisições.
export async function findEstablishmentByPhoneNumberId(
  phoneNumberId: string,
): Promise<Establishment | null> {
  const snap = await db
    .collection("establishments")
    .where("whatsapp.phoneNumberId", "==", phoneNumberId)
    .limit(TENANT_LOOKUP_CANDIDATES)
    .get();

  const connected = snap.docs
    .map((d) => d.data() as Establishment)
    .filter((est) => est.whatsapp?.status === "connected");

  if (connected.length === 0) return null;

  // Mais de um estabelecimento CONECTADO no mesmo número é um estado
  // inválido que este código não tem como desempatar corretamente (as
  // mensagens pertencem a um só dono). Não adivinha em silêncio: registra
  // para investigação e segue com o primeiro, mantendo o atendimento de pé.
  if (connected.length > 1) {
    console.error(
      `[livia webhook] phone_number_id ${phoneNumberId} está conectado em ${connected.length} estabelecimentos ` +
        `(${connected.map((e) => e.id).join(", ")}) — usando o primeiro; corrigir os dados.`,
    );
  }

  return connected[0]!;
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
