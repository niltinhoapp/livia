import type { Establishment } from "@/types";

// Kill switch operacional de Campanhas. O envio fica ativo por padrão após a
// liberação consciente da funcionalidade; definir explicitamente `false` no
// ambiente continua sendo o rollback imediato, sem novo deploy.
export function campaignsSendEnabled(): boolean {
  return process.env.CAMPAIGNS_SEND_ENABLED !== "false";
}

/**
 * Limite operacional por campanha.
 *
 * Durante o trial a conta pode enviar no máximo 100 destinatários por
 * campanha. Depois que o billing deixa de ser "trial", o limite comercial
 * deixa de ser o gargalo e vale apenas o teto técnico síncrono atual (200).
 * Contas legadas sem billing também usam o teto técnico.
 */
export function campaignsMaxRecipientsPerCampaign(
  establishment?: Pick<Establishment, "billing"> | null,
): number {
  if (establishment?.billing?.billingStatus === "trial") return 100;

  const raw = Number.parseInt(process.env.CAMPAIGNS_MAX_RECIPIENTS_PER_CAMPAIGN ?? "200", 10);
  if (!Number.isFinite(raw) || raw < 1) return 200;
  return Math.min(raw, 200);
}
