// Kill switch operacional de Campanhas. O default é fechado: publicar o
// código não habilita nenhum disparo até uma ativação consciente em ambiente.
export function campaignsSendEnabled(): boolean {
  return process.env.CAMPAIGNS_SEND_ENABLED === "true";
}

export function campaignsMaxRecipientsPerCampaign(): number {
  const raw = Number.parseInt(process.env.CAMPAIGNS_MAX_RECIPIENTS_PER_CAMPAIGN ?? "5", 10);
  if (!Number.isFinite(raw) || raw < 1) return 5;
  return Math.min(raw, 200);
}
