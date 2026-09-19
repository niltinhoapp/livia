// Kill switch operacional de Campanhas. O envio fica ativo por padrão após a
// liberação consciente da funcionalidade; definir explicitamente `false` no
// ambiente continua sendo o rollback imediato, sem novo deploy.
export function campaignsSendEnabled(): boolean {
  return process.env.CAMPAIGNS_SEND_ENABLED !== "false";
}

export function campaignsMaxRecipientsPerCampaign(): number {
  const raw = Number.parseInt(process.env.CAMPAIGNS_MAX_RECIPIENTS_PER_CAMPAIGN ?? "5", 10);
  if (!Number.isFinite(raw) || raw < 1) return 5;
  return Math.min(raw, 200);
}
