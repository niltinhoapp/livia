import type { Transaction } from "firebase-admin/firestore";
import { sub } from "@/lib/firebase/admin";
import type { AutomationFence, Conversation } from "@/types";

export class AutomationFenceError extends Error {
  constructor() {
    super("automation_turn_is_no_longer_authorized");
    this.name = "AutomationFenceError";
  }
}

// Precisa ser chamado dentro da MESMA transação da mutação protegida. A
// leitura faz handoff, expiração e troca de owner participarem da detecção de
// conflito do Firestore; uma checagem feita antes da transação seria TOCTOU.
export async function assertAutomationFence(
  tx: Transaction,
  establishmentId: string,
  fence: AutomationFence | undefined,
  now = Date.now(),
): Promise<void> {
  if (!fence) return;
  const snap = await tx.get(sub(establishmentId, "conversations").doc(fence.conversationId));
  if (!snap.exists) throw new AutomationFenceError();
  const conversation = snap.data() as Conversation;
  const lease = conversation.aiProcessingLease;
  if (
    conversation.status !== "bot" ||
    !lease ||
    lease.leaseId !== fence.leaseId ||
    lease.expiresAt <= now
  ) {
    throw new AutomationFenceError();
  }
}
