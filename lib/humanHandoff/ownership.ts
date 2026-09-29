// Posse humana de uma conversa. Única porta de entrada/saída do estado
// "human": ações autenticadas do responsável no painel. Não existe caminho
// automático human → bot (tempo, cron, inatividade ou heurística) — o
// webhook nunca chama estas funções.
import { db, sub } from "@/lib/firebase/admin";
import type { Conversation, PendingTask } from "@/types";

export type OwnershipResult =
  | { ok: true; status: "human" | "bot"; changed: boolean }
  | { ok: false; error: "not_found" | "invalid_state" };

// bot/handoff/closed → human. Revoga o lease da automação no mesmo commit:
// uma resposta da Lívia em andamento é descartada antes do envio.
export async function assumeConversation(
  establishmentId: string,
  conversationId: string,
  actorUid: string,
  now = Date.now(),
): Promise<OwnershipResult> {
  const conversationRef = sub(establishmentId, "conversations").doc(conversationId);
  const pendingRef = sub(establishmentId, "pendingTasks").doc(conversationId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(conversationRef);
    const pendingSnap = await tx.get(pendingRef);
    if (!snap.exists) return { ok: false, error: "not_found" } as const;
    const conversation = snap.data() as Conversation;
    if (conversation.status === "human") return { ok: true, status: "human", changed: false } as const;
    tx.update(conversationRef, {
      status: "human",
      aiProcessingLease: null,
      awaitingHumanOfferConfirmation: false,
      humanOwnership: { assumedAt: now, assumedBy: actorUid },
      // Assumir direto (sem handoff pendente) abre um episódio novo de avisos.
      ...(conversation.status === "handoff" ? {} : { handoffStartedAt: null }),
    });
    // Assumir atende o que estava pendente nesta conversa.
    if (pendingSnap.exists && (pendingSnap.data() as PendingTask).status === "open") {
      tx.update(pendingRef, { status: "resolved", resolvedAt: now, updatedAt: now });
    }
    return { ok: true, status: "human", changed: true } as const;
  });
}

// human/handoff → bot, somente por ação explícita do responsável. Idempotente
// quando a conversa já está com a Lívia; conversa encerrada não é devolvida.
export async function returnConversationToBot(
  establishmentId: string,
  conversationId: string,
  actorUid: string,
  now = Date.now(),
): Promise<OwnershipResult> {
  const conversationRef = sub(establishmentId, "conversations").doc(conversationId);
  const pendingRef = sub(establishmentId, "pendingTasks").doc(conversationId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(conversationRef);
    const pendingSnap = await tx.get(pendingRef);
    if (!snap.exists) return { ok: false, error: "not_found" } as const;
    const conversation = snap.data() as Conversation;
    if (conversation.status === "bot") return { ok: true, status: "bot", changed: false } as const;
    if (conversation.status !== "human" && conversation.status !== "handoff") return { ok: false, error: "invalid_state" } as const;
    tx.update(conversationRef, {
      status: "bot",
      aiProcessingLease: null,
      awaitingHumanOfferConfirmation: false,
      handoffStartedAt: null,
      humanOwnership: {
        assumedAt: conversation.humanOwnership?.assumedAt ?? now,
        assumedBy: conversation.humanOwnership?.assumedBy ?? actorUid,
        returnedAt: now,
        returnedBy: actorUid,
      },
    });
    // Só a pendência de atendimento humano é encerrada: outra (agendamento
    // incompleto, reclamação) não foi atendida por esta ação.
    const pending = pendingSnap.exists ? (pendingSnap.data() as PendingTask) : null;
    if (pending?.status === "open" && pending.type === "awaiting_human") {
      tx.update(pendingRef, { status: "resolved", resolvedAt: now, updatedAt: now });
    }
    return { ok: true, status: "bot", changed: true } as const;
  });
}
