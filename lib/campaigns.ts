// Regras puras de marketing. Deliberadamente separadas do sender WhatsApp:
// elegibilidade é decidida no backend antes de qualquer dispatcher futuro.
import type { CustomerProfile, MarketingStatus } from "@/types";

export type MarketingEligibilityReason =
  | "eligible"
  | "legacy_without_explicit_consent"
  | "opted_out"
  | "blocked";

export interface MarketingEligibility {
  eligible: boolean;
  reason: MarketingEligibilityReason;
}

// Fail-safe: um perfil criado antes de Campanhas-02 não tem consentimento
// explícito e, portanto, NÃO pode receber marketing. Isso não afeta nenhuma
// outra capacidade da Lívia.
export function marketingEligibilityOf(
  profile: Pick<CustomerProfile, "marketingStatus">,
): MarketingEligibility {
  const status: MarketingStatus | undefined = profile.marketingStatus;
  if (status === "eligible") return { eligible: true, reason: "eligible" };
  if (status === "opted_out") return { eligible: false, reason: "opted_out" };
  if (status === "blocked") return { eligible: false, reason: "blocked" };
  return { eligible: false, reason: "legacy_without_explicit_consent" };
}
