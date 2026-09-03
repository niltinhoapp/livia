// Caixa de entrada inteligente — Passo 11 do README.md/Plano Mestre.
//
// Função pura: classifica UMA conversa a partir de campos que já existem
// (status, PendingTask aberta pra ela, se está na lista de oportunidades do
// Passo 12) — nenhuma fonte de verdade nova, nenhuma persistência própria.
// Prioridade da classificação: o motivo mais urgente de atenção vence
// (precisa de humano > reclamação > cliente aguardando > agendamento
// incompleto > oportunidade > resolvida).
import type { Conversation, InboxCategory, PendingTaskType } from "@/types";

export interface ClassifyConversationInput {
  status: Conversation["status"];
  // Tipo da PendingTask ABERTA desta conversa, se houver — vem de
  // lib/repo.ts (listPendingTasks), nunca recalculado aqui.
  pendingTaskType?: PendingTaskType;
  // true se esta conversa aparece na lista de Opportunity (Passo 12) —
  // reaproveita a mesma detecção, não duplica critério.
  hasOpportunity: boolean;
}

export function classifyConversation(input: ClassifyConversationInput): InboxCategory {
  const { status, pendingTaskType, hasOpportunity } = input;

  if (status === "handoff" || pendingTaskType === "awaiting_human") return "needs_human";
  if (pendingTaskType === "exception_needs_establishment") return "complaint";
  if (pendingTaskType === "awaiting_customer_confirmation") return "customer_waiting";
  if (pendingTaskType === "appointment_started_incomplete") return "appointment_incomplete";
  if (hasOpportunity) return "opportunity";
  return "resolved";
}

export const INBOX_CATEGORY_LABEL: Record<InboxCategory, string> = {
  needs_human: "Precisa de humano",
  customer_waiting: "Cliente aguardando",
  appointment_incomplete: "Agendamento incompleto",
  opportunity: "Oportunidade",
  complaint: "Reclamação",
  resolved: "Sem pendência",
};
