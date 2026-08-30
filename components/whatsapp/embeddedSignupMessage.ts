// Parsing seguro das mensagens window.postMessage do Embedded Signup da
// Meta. Duas defesas obrigatórias, sempre aplicadas juntas por quem usa isto:
//   1. `isAllowedEmbeddedSignupOrigin(event.origin)` — só processa mensagens
//      vindas de origens oficiais da Meta/Facebook, nunca origem arbitrária.
//   2. `parseEmbeddedSignupMessage(event.data)` — só reconhece o formato
//      `{ type: "WA_EMBEDDED_SIGNUP", event, data }`; qualquer outra coisa
//      (inclusive JSON malformado) retorna null e é ignorada.
//
// De propósito, este parser NUNCA extrai um `code` daqui — o authorization
// code só é confiável vindo do callback do FB.login (ver useEmbeddedSignup),
// nunca do postMessage.
const ALLOWED_ORIGINS = new Set(["https://www.facebook.com", "https://web.facebook.com"]);

export function isAllowedEmbeddedSignupOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin);
}

export interface EmbeddedSignupMessage {
  event: string; // "FINISH" | "CANCEL" | outros que a Meta possa enviar
  wabaId?: string;
  phoneNumberId?: string;
}

export function parseEmbeddedSignupMessage(raw: unknown): EmbeddedSignupMessage | null {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;
  if (obj.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (typeof obj.event !== "string") return null;

  const data = obj.data as Record<string, unknown> | undefined;
  const wabaId = typeof data?.waba_id === "string" ? data.waba_id : undefined;
  const phoneNumberId = typeof data?.phone_number_id === "string" ? data.phone_number_id : undefined;

  return { event: obj.event, wabaId, phoneNumberId };
}
