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
