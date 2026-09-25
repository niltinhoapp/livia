import type { Establishment, ProspectingSession } from "@/types";

export type DemoAuthorization =
  | { authorized: true; establishmentId: string; prospectingLeadId: string }
  | { authorized: false };

/**
 * Valida uma autorização já carregada pela camada de borda. Esta função não
 * consulta nem altera Firestore; ausência de qualquer prova falha fechada.
 */
export function authorizeDemo(input: {
  establishment: Establishment;
  internalDemoProspectingEstablishmentId: string | undefined;
  session: ProspectingSession | null | undefined;
  phone: string;
  leadId: string;
  now?: number;
}): DemoAuthorization {
  const { establishment, internalDemoProspectingEstablishmentId, session, phone, leadId } = input;
  const now = input.now ?? Date.now();
  if (!internalDemoProspectingEstablishmentId || establishment.id !== internalDemoProspectingEstablishmentId) return { authorized: false };
  if (establishment.demoChannel?.enabled !== true) return { authorized: false };
  if (!session || session.establishmentId !== establishment.id || session.normalizedPhone !== phone) return { authorized: false };
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now) return { authorized: false };
  if (session.status !== "REVEALED" && session.status !== "INTERESTED") return { authorized: false };
  if (session.leadId !== leadId) return { authorized: false };
  return { authorized: true, establishmentId: establishment.id, prospectingLeadId: session.leadId };
}
