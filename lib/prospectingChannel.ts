export type ProspectingChannel = "revenue" | "demo";

export function parseProspectingChannel(value: unknown): ProspectingChannel | null {
  if (value === undefined || value === null || value === "") return "revenue";
  return value === "revenue" || value === "demo" ? value : null;
}

export function prospectingEstablishmentId(channel: ProspectingChannel): string | null {
  return channel === "demo"
    ? process.env.INTERNAL_DEMO_PROSPECTING_ESTABLISHMENT_ID || null
    : process.env.INTERNAL_PROSPECTING_ESTABLISHMENT_ID || null;
}

// Canais em que a Lívia vende a si mesma (tenants internos de prospecção e o
// canal de demonstração). Só neles uma conversa pode estar em Audit ou
// Commercial; num estabelecimento cliente ela sempre representa o negócio —
// um paciente que escreve "diagnóstico" não pode virar lead da Lívia.
export function isLiviaCommercialChannel(establishment: { id: string; demoChannel?: { enabled?: boolean } | null }): boolean {
  const internal = [process.env.INTERNAL_PROSPECTING_ESTABLISHMENT_ID, process.env.INTERNAL_DEMO_PROSPECTING_ESTABLISHMENT_ID].filter(Boolean);
  return internal.includes(establishment.id) || establishment.demoChannel?.enabled === true;
}
