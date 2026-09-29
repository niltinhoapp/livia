// Regras puras (sem Firestore, Meta ou FCM) da notificação de handoff humano.
import type { Conversation, ConversationContext, Establishment, HumanHandoffNotificationConfig } from "@/types";
import { isLiviaCommercialChannel } from "@/lib/prospectingChannel";

// Política de deduplicação/reaviso:
// - handoff confirmado: push + template no máximo UMA vez por episódio;
// - cliente escreve de novo (handoff pendente ou atendimento humano): só
//   push, no máximo um a cada 30 minutos por episódio. Template nunca repete.
// Nenhum aviso altera posse: o estado da conversa é a fonte de verdade.
export const HANDOFF_PUSH_REMINDER_INTERVAL_MS = 30 * 60 * 1000;

// Só o atendimento real de um estabelecimento cliente avisa o responsável.
// Canais da própria Lívia (prospecção, Auditoria, demonstração) nunca.
export function shouldNotifyHumanHandoff(
  establishment: Pick<Establishment, "id" | "demoChannel" | "humanHandoffNotifications">,
  context: Pick<ConversationContext, "purpose"> | undefined,
): boolean {
  const config = establishment.humanHandoffNotifications;
  if (!config || (!config.push && !config.whatsapp)) return false;
  if ((context?.purpose ?? "operational") !== "operational") return false;
  return !isLiviaCommercialChannel(establishment);
}

export function handoffEpisodeId(conversation: Pick<Conversation, "id" | "handoffStartedAt" | "humanOwnership">): string | null {
  if (conversation.handoffStartedAt) return `${conversation.id}_${conversation.handoffStartedAt}`;
  if (conversation.humanOwnership?.assumedAt && !conversation.humanOwnership.returnedAt) {
    return `${conversation.id}_h${conversation.humanOwnership.assumedAt}`;
  }
  return null;
}

export function conversationPanelPath(conversationId: string): string {
  return `/painel/conversas?conversa=${encodeURIComponent(conversationId)}`;
}

export function customerLabel(conversation: Pick<Conversation, "contactName" | "contactPhone">): string {
  return conversation.contactName?.trim() || conversation.contactPhone;
}

// Variáveis do corpo aceitas no template do aviso: nenhuma, {{1}} (cliente)
// ou {{1}} e {{2}} (cliente e link da conversa).
export function templateParamsFor(
  config: Pick<HumanHandoffNotificationConfig, "templateParamCount">,
  conversation: Pick<Conversation, "id" | "contactName" | "contactPhone">,
  appBaseUrl: string | undefined,
): string[] {
  const link = appBaseUrl
    ? `${appBaseUrl.replace(/\/+$/, "")}${conversationPanelPath(conversation.id)}`
    : "painel da Lívia > Conversas";
  return [customerLabel(conversation), link].slice(0, config.templateParamCount);
}
