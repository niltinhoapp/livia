import type {
  ConversationContext,
  ConversationPurpose,
  Message,
  ProspectingSession,
} from "@/types";

export const CONVERSATION_CAPABILITIES = [
  "agenda_read",
  "agenda_mutate",
  "catalog_read",
  "order_read",
  "order_mutate",
  "customer_profile_read",
  "customer_profile_mutate",
  "human_handoff",
  "commercial_guidance",
  "demo_execution",
] as const;

export type ConversationCapability = (typeof CONVERSATION_CAPABILITIES)[number];
export type ConversationCapabilities = Readonly<Record<ConversationCapability, boolean>>;

const TERMINAL_PROSPECTING_STATUSES = new Set([
  "NOT_INTERESTED",
  "HUMAN",
  "EXPIRED",
  "CLOSED",
  "OPTED_OUT",
]);

export function isActiveProspectingSession(session: ProspectingSession | null | undefined, now = Date.now()): boolean {
  return Boolean(session && session.expiresAt > now && !TERMINAL_PROSPECTING_STATUSES.has(session.status));
}

export interface ConversationContextResolution {
  context: ConversationContext;
  changed: boolean;
  enteredAudit: boolean;
  clearOperationalTask: boolean;
}

/**
 * Precedência deliberada:
 * 0. fora de um canal comercial da Lívia, sempre operational — o
 *    estabelecimento cliente nunca vira Audit/Commercial (e um documento que
 *    já tenha virado volta a operational);
 * 1. entrada explícita de Audit;
 * 2. jornada originada em Audit já persistida (mesmo após Audit -> Commercial,
 *    uma ProspectingSession não apaga seus dados/boundary no turno seguinte);
 * 3. ProspectingSession ativa;
 * 4. contexto persistido;
 * 5. operational para documentos antigos.
 *
 * Sessão terminal não causa uma transição implícita: o contexto comercial
 * permanece até uma condição explícita de ativação operacional futura.
 *
 * `freshAuditEntry`: a mensagem traz o resultado rotulado da Calculadora
 * (o texto pré-preenchido do CTA). É uma jornada NOVA mesmo que a conversa já
 * esteja em Audit — nova fronteira de histórico e nenhum dado herdado da
 * Auditoria anterior.
 */
export function resolveConversationContext(input: {
  persisted?: ConversationContext | null;
  prospectingSession?: ProspectingSession | null;
  commercialChannel: boolean;
  startsAudit: boolean;
  freshAuditEntry?: boolean;
  now?: number;
}): ConversationContextResolution {
  const now = input.now ?? Date.now();
  const persisted = input.persisted ?? null;
  let purpose: ConversationPurpose;
  let source: ConversationContext["source"];

  if (!input.commercialChannel) {
    purpose = "operational";
    source = "normal";
  } else if (input.startsAudit) {
    purpose = "audit";
    source = "audit_calculator";
  } else if (persisted?.source === "audit_calculator") {
    purpose = persisted.purpose;
    source = persisted.source;
  } else if (isActiveProspectingSession(input.prospectingSession, now)) {
    purpose = "commercial";
    source = "prospecting";
  } else if (persisted) {
    purpose = persisted.purpose;
    source = persisted.source;
  } else {
    purpose = "operational";
    source = "normal";
  }

  // Documento legado operacional não precisa de backfill: o default efetivo
  // é suficiente e evita uma escrita massiva incidental.
  const enteredAudit = purpose === "audit"
    && (persisted?.purpose !== "audit" || (input.startsAudit && input.freshAuditEntry === true));
  const changed = persisted
    ? persisted.purpose !== purpose || persisted.source !== source || enteredAudit
    : purpose !== "operational";
  const context: ConversationContext = changed || !persisted
    ? { purpose, source, enteredAt: now, updatedAt: now }
    : persisted!;

  return {
    context,
    changed,
    enteredAudit,
    clearOperationalTask: changed && purpose !== "operational",
  };
}

export function capabilitiesForConversation(input: {
  context: ConversationContext;
  bookingEnabled: boolean;
  ordersEnabled: boolean;
  demoAuthorized: boolean;
  // Compatibilidade temporária para chamadores antigos. É somente uma trava
  // adicional; nunca concede capacidade e não é a fonte de verdade.
  suppressBooking?: boolean;
}): ConversationCapabilities {
  const { context } = input;
  const operational = context.purpose === "operational";
  const demo = context.purpose === "commercial" && input.demoAuthorized;
  const agendaRead = (operational || demo) && !input.suppressBooking;

  return {
    agenda_read: agendaRead,
    agenda_mutate: agendaRead && input.bookingEnabled,
    // Catálogo é informação do estabelecimento já exposta pela prospecção
    // existente; carrinho/status do contato continuam protegidos abaixo.
    catalog_read: context.purpose !== "audit" && input.ordersEnabled,
    order_read: (operational || demo) && input.ordersEnabled,
    order_mutate: (operational || demo) && input.ordersEnabled,
    customer_profile_read: operational,
    customer_profile_mutate: operational,
    human_handoff: true,
    commercial_guidance: context.purpose === "commercial" || context.purpose === "audit",
    demo_execution: demo,
  };
}

export function hasCapability(capabilities: ConversationCapabilities, capability: ConversationCapability): boolean {
  return capabilities[capability];
}

// O boundary é durável: na entrada, somente a mensagem corrente; depois,
// todas as mensagens desde enteredAt. A origem audit_calculator mantém a
// barreira mesmo após Audit -> Commercial, preservando a jornada sem voltar
// a receber o histórico operacional anterior.
export function historyForConversationContext(
  history: Message[],
  resolution: Pick<ConversationContextResolution, "context" | "enteredAudit">,
): Message[] {
  if (resolution.context.source !== "audit_calculator") return history;
  if (resolution.enteredAudit) return history.slice(-1);
  return history.filter((message) => message.at >= resolution.context.enteredAt);
}

export type ExplicitContextTransitionReason =
  | "audit_qualified"
  | "customer_activated"
  | "manual_operational_reset";

/** Transições futuras são explícitas; texto genérico nunca muda o papel. */
export function transitionConversationContext(
  current: ConversationContext,
  target: ConversationPurpose,
  reason: ExplicitContextTransitionReason,
  now = Date.now(),
): ConversationContext {
  const allowed =
    (current.purpose === "audit" && target === "commercial" && reason === "audit_qualified") ||
    (current.purpose === "commercial" && target === "operational" && reason === "customer_activated") ||
    (target === "operational" && reason === "manual_operational_reset");
  if (!allowed) throw new Error(`invalid_conversation_context_transition:${current.purpose}:${target}:${reason}`);
  return {
    ...current,
    purpose: target,
    source: target === "operational" ? "normal" : current.source,
    enteredAt: reason === "audit_qualified" ? current.enteredAt : now,
    updatedAt: now,
  };
}
