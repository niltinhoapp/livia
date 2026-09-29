import type { ConversationContext, Establishment, ProspectingSession } from "@/types";

// `prospectingLeadId` é a chave de isolamento dos registros demo (agenda,
// pedidos, limpeza). Vem da ProspectingSession na prospecção e do acesso demo
// da própria jornada na Auditoria — nenhuma das duas portas depende da outra.
export type DemoAuthorization =
  | { authorized: true; establishmentId: string; prospectingLeadId: string }
  | { authorized: false };

export const AUDIT_DEMO_ACCESS_TTL_MS = 48 * 60 * 60 * 1000;

function isOfficialDemoChannel(establishment: Establishment, internalDemoProspectingEstablishmentId: string | undefined): boolean {
  return Boolean(internalDemoProspectingEstablishmentId)
    && establishment.id === internalDemoProspectingEstablishmentId
    && establishment.demoChannel?.enabled === true;
}

function auditDemoLeadId(phone: string, context: ConversationContext): string {
  return `audit_${phone}_${context.enteredAt}`;
}

/**
 * Valida uma autorização já carregada pela camada de borda. Esta função não
 * consulta nem altera Firestore; ausência de qualquer prova falha fechada.
 *
 * Jornada da Calculadora (source audit_calculator): a prova é o acesso demo da
 * própria conversa, e uma ProspectingSession do mesmo telefone é ignorada.
 * Prospecção: a prova continua sendo a ProspectingSession revelada.
 */
export function authorizeDemo(input: {
  establishment: Establishment;
  internalDemoProspectingEstablishmentId: string | undefined;
  session: ProspectingSession | null | undefined;
  phone: string;
  leadId: string;
  context?: ConversationContext | null;
  now?: number;
}): DemoAuthorization {
  const { establishment, internalDemoProspectingEstablishmentId, session, phone, leadId, context } = input;
  const now = input.now ?? Date.now();
  if (!isOfficialDemoChannel(establishment, internalDemoProspectingEstablishmentId)) return { authorized: false };

  if (context?.source === "audit_calculator") {
    const access = context.demoAccess;
    if (context.purpose !== "commercial" || !access) return { authorized: false };
    if (!Number.isFinite(access.expiresAt) || access.expiresAt <= now) return { authorized: false };
    if (access.leadId !== auditDemoLeadId(phone, context)) return { authorized: false };
    return { authorized: true, establishmentId: establishment.id, prospectingLeadId: access.leadId };
  }

  if (!session || session.establishmentId !== establishment.id || session.normalizedPhone !== phone) return { authorized: false };
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now) return { authorized: false };
  if (session.status !== "REVEALED" && session.status !== "INTERESTED") return { authorized: false };
  if (session.leadId !== leadId) return { authorized: false };
  return { authorized: true, establishmentId: establishment.id, prospectingLeadId: session.leadId };
}

/**
 * Concede (ou renova) o acesso demo de uma jornada da Calculadora. Sequência:
 * Audit detectada → diagnóstico → interesse/aceite explícito (a conversa já é
 * Commercial) → acesso. Nunca no turno de entrada, nunca fora do canal demo.
 */
export function grantAuditDemoAccess(input: {
  context: ConversationContext;
  establishment: Establishment;
  internalDemoProspectingEstablishmentId: string | undefined;
  phone: string;
  demoRequested: boolean;
  now: number;
}): ConversationContext {
  const { context, now } = input;
  if (!input.demoRequested || !input.phone) return context;
  if (context.source !== "audit_calculator" || context.purpose !== "commercial") return context;
  if (!isOfficialDemoChannel(input.establishment, input.internalDemoProspectingEstablishmentId)) return context;
  return {
    ...context,
    demoAccess: { leadId: auditDemoLeadId(input.phone, context), grantedAt: now, expiresAt: now + AUDIT_DEMO_ACCESS_TTL_MS },
    updatedAt: now,
  };
}
