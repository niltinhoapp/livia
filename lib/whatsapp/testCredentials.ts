export type WhatsappTestCredentials = {
  phoneNumberId: string;
  accessToken: string;
  establishmentId: string;
};

/**
 * As credenciais de App Review nunca podem mudar o comportamento de um
 * deployment de produção. Preview é o único ambiente Vercel autorizado; os
 * testes unitários também podem exercitar esse caminho sem depender da Vercel.
 * Desenvolvimento local e qualquer ambiente desconhecido falham fechados.
 */
function isWhatsappTestEnvironment(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  return process.env.VERCEL_ENV === "preview" || process.env.NODE_ENV === "test";
}

export function getWhatsappTestCredentials(): WhatsappTestCredentials | null {
  if (!isWhatsappTestEnvironment()) return null;

  const phoneNumberId = process.env.WHATSAPP_TEST_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_TEST_ACCESS_TOKEN;
  const establishmentId = process.env.WHATSAPP_TEST_ESTABLISHMENT_ID;
  if (!phoneNumberId || !accessToken || !establishmentId) return null;

  return { phoneNumberId, accessToken, establishmentId };
}
