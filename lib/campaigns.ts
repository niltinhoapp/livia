// Regras puras de marketing. Deliberadamente separadas do sender WhatsApp:
// elegibilidade é decidida no backend antes de qualquer dispatcher futuro.
import { normalizePhone } from "@/lib/whatsapp/client";
import type { CustomerProfile, MarketingOptInSource, MarketingStatus } from "@/types";

export type MarketingEligibilityReason =
  | "eligible"
  | "legacy_without_explicit_consent"
  | "opted_out"
  | "blocked";

export interface MarketingEligibility {
  eligible: boolean;
  reason: MarketingEligibilityReason;
}

export const MARKETING_OPT_IN_SOURCES: readonly MarketingOptInSource[] = [
  "website_form",
  "landing_page",
  "checkout",
  "physical_store",
  "qr_code",
  "whatsapp",
  "crm_import",
  "other",
];

export function isMarketingOptInSource(value: unknown): value is MarketingOptInSource {
  return typeof value === "string" && MARKETING_OPT_IN_SOURCES.includes(value as MarketingOptInSource);
}

// Reaproveita a normalização canônica do sender. Para a entrada brasileira
// local, exigimos DDD + número (10/11 dígitos); números já internacionais
// devem respeitar o limite E.164 de 15 dígitos.
export function normalizeMarketingImportPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  const normalized = normalizePhone(digits);
  return /^\d{12,15}$/.test(normalized) ? normalized : null;
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
