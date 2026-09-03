// Oportunidades e funil — Passo 12 do README.md/Plano Mestre.
//
// Todas as funções aqui são puras e determinísticas — recebem dados JÁ
// buscados (nada de I/O neste arquivo) e devolvem `Opportunity[]`. Nenhum
// LLM, nenhuma pontuação inventada: cada oportunidade carrega `evidence`
// apontando pro dado concreto (coleção/campo) que a gerou. A orquestração
// (quais queries buscar) fica em lib/repo.ts: getOpportunities().
import { normalizePhone } from "@/lib/whatsapp/client";
import type { Appointment, Conversation, Opportunity, OpportunityType, PendingTask, PendingTaskType } from "@/types";

// Mapeia diretamente os tipos de PendingTask (Passo 9) que já representam,
// por definição, algo comercialmente relevante parado — reaproveita a
// detecção do Pacote 2 em vez de reimplementar critério.
const PENDING_TASK_OPPORTUNITY: Partial<Record<PendingTaskType, { type: OpportunityType; label: string }>> = {
  awaiting_human: { type: "handoff_waiting", label: "Aguardando atendimento humano" },
  appointment_started_incomplete: { type: "appointment_incomplete", label: "Agendamento iniciado e não concluído" },
  awaiting_customer_confirmation: { type: "awaiting_confirmation", label: "Recebeu horários e ainda não confirmou" },
  exception_needs_establishment: { type: "complaint_unresolved", label: "Reclamação sem resolução" },
};

export function opportunitiesFromPendingTasks(
  pendingTasks: PendingTask[],
  contactNameByConversationId: Map<string, string | null>,
): Opportunity[] {
  const out: Opportunity[] = [];
  for (const pt of pendingTasks) {
    const mapped = PENDING_TASK_OPPORTUNITY[pt.type];
    if (!mapped) continue;
    out.push({
      type: mapped.type,
      conversationId: pt.conversationId,
      contactPhone: pt.contactPhone,
      contactName: contactNameByConversationId.get(pt.conversationId) ?? null,
      label: mapped.label,
      evidence: `pendingTasks/${pt.conversationId} (type=${pt.type}, waitingFor="${pt.waitingFor}")`,
      detectedAt: pt.updatedAt,
    });
  }
  return out;
}

// Cliente perguntou preço, a conversa não está em handoff/human (a Livia
// respondeu sozinha) e não existe nenhum agendamento ativo (pendente ou
// confirmado) dele no horizonte futuro — sinal de que perguntou e não
// avançou. `conversations` já deve vir filtrada pro período desejado por
// quem chama (getOpportunities).
export function priceInquiryOpportunities(
  conversations: Conversation[],
  hasActiveAppointment: (contactPhone: string) => boolean,
): Opportunity[] {
  return conversations
    .filter((c) => c.lastIntent === "ask_price" && c.status === "bot" && !hasActiveAppointment(c.contactPhone))
    .map((c) => ({
      type: "price_inquiry_no_booking" as const,
      conversationId: c.id,
      contactPhone: c.contactPhone,
      contactName: c.contactName,
      label: "Perguntou o preço e não agendou",
      evidence: `conversations/${c.id} (lastIntent=ask_price, status=bot)`,
      detectedAt: c.lastMessageAt,
    }));
}

// Um agendamento foi cancelado e o cliente não tem nenhum outro ativo —
// oportunidade de recuperação. `cancelledAppointments` já deve vir filtrada
// por período por quem chama.
export function cancelledNoRebookingOpportunities(
  cancelledAppointments: Appointment[],
  hasActiveAppointment: (contactPhone: string) => boolean,
): Opportunity[] {
  return cancelledAppointments
    .filter((a) => !hasActiveAppointment(a.contactPhone))
    .map((a) => ({
      type: "cancelled_no_rebooking" as const,
      // Mesma convenção do resto do sistema: conversationId = telefone
      // normalizado (ver lib/repo.ts: loadConversation).
      conversationId: normalizePhone(a.contactPhone),
      contactPhone: a.contactPhone,
      contactName: a.contactName,
      label: "Cancelou e ainda não remarcou",
      evidence: `appointments/${a.id} (status=cancelled)`,
      detectedAt: a.cancelledAt ?? a.createdAt,
    }));
}
