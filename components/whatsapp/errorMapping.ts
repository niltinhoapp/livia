// Mapeia as categorias sanitizadas que o backend já devolve (ver
// app/api/whatsapp/connect/route.ts) para os grupos visuais da seção H da
// especificação. Usado quando a integração real (POST com code/waba/phone)
// existir.
import type { WhatsAppPhase } from "./WhatsAppConnectionCard";

export function mapErrorToPhase(code: string): WhatsAppPhase {
  if (code === "CONNECTION_IN_PROGRESS" || code === "ALREADY_CONNECTED") return "in-progress";
  if (code === "OWNERSHIP_MISMATCH" || code === "SUBSCRIBE_FAILED" || code === "REGISTER_FAILED") return "error-attention";
  return "error-recoverable"; // EXCHANGE_FAILED, STALE_ATTEMPT, INVALID_PAYLOAD, INTERNAL_ERROR
}
