// Cliente da Meta Cloud API para a Livia.
// Diferença crucial em relação ao Nuvem Rush: aqui é CONVERSA. Quando o
// cliente manda mensagem, abre-se uma janela de 24h em que podemos responder
// com TEXTO LIVRE — sem template aprovado. É isso que o bot usa.
//
// Credenciais vêm SEMPRE do estabelecimento (Embedded Signup / Tech Provider);
// a Meta cobra as conversas direto dele. O accessToken é sempre armazenado
// cifrado (EncryptedToken) — este módulo decifra em memória, na hora de
// montar cada requisição, e nunca guarda/loga/devolve o valor em claro.
import { decryptToken } from "@/lib/whatsapp/tokenCrypto";
import type { EstablishmentWhatsapp } from "@/types";

const GRAPH = "https://graph.facebook.com/v22.0";

// Normaliza pro formato da Graph API (dígitos com DDI). Até 11 dígitos =
// número BR sem DDI -> prefixa 55.
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length <= 11) return `55${digits}`;
  return digits;
}

// Único ponto de decrypt do módulo — evita duplicar a checagem de elegibilidade
// e a chamada a decryptToken em cada função de envio. O token retornado só
// existe na variável local de quem chamou; nunca é logado, persistido ou
// devolvido ao chamador além do uso imediato no header Authorization.
//
// Só status === "connected" pode enviar mensagem — "connecting" é um estado
// transitório do Embedded Signup (só tem PIN, nunca token) e "disconnected"
// não tem credencial válida. Falha explícita em qualquer outro caso, nunca
// monta um Authorization vazio/inválido.
function resolveSendCredentials(wa: EstablishmentWhatsapp): {
  phoneNumberId: string;
  accessToken: string;
} {
  if (wa.status !== "connected") {
    throw new Error(`WhatsApp não está conectado (status atual: "${wa.status}").`);
  }
  if (!wa.accessToken) {
    throw new Error("WhatsApp conectado, mas sem accessToken cifrado — estado inconsistente.");
  }
  return { phoneNumberId: wa.phoneNumberId, accessToken: decryptToken(wa.accessToken) };
}

// Envia texto livre (só válido dentro da janela de 24h aberta pelo cliente).
export async function sendText(
  wa: EstablishmentWhatsapp,
  toPhone: string,
  text: string,
): Promise<{ waMessageId?: string }> {
  const { phoneNumberId, accessToken } = resolveSendCredentials(wa);
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizePhone(toPhone),
      type: "text",
      text: { preview_url: false, body: text },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp sendText ${res.status}: ${body}`);
  }
  const data = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
  };
  return { waMessageId: data.messages?.[0]?.id };
}

// Envia mensagem de TEMPLATE (HSM). Necessária para envios PROATIVOS fora da
// janela de 24h — é o caso do lembrete de agendamento. O template precisa
// estar aprovado na WABA do estabelecimento. `params` preenche as variáveis
// {{1}}, {{2}}... do corpo, na ordem.
export async function sendTemplate(
  wa: EstablishmentWhatsapp,
  toPhone: string,
  templateName: string,
  languageCode: string,
  params: string[] = [],
): Promise<{ waMessageId?: string }> {
  const { phoneNumberId, accessToken } = resolveSendCredentials(wa);
  const components =
    params.length > 0
      ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
      : undefined;

  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizePhone(toPhone),
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp sendTemplate ${res.status}: ${body}`);
  }
  const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[] };
  return { waMessageId: data.messages?.[0]?.id };
}

// Marca a mensagem recebida como lida (opcional, melhora a UX — o cliente vê
// o "visto" azul enquanto a IA formula a resposta).
export async function markAsRead(
  wa: EstablishmentWhatsapp,
  waMessageId: string,
): Promise<void> {
  let phoneNumberId: string;
  let accessToken: string;
  try {
    ({ phoneNumberId, accessToken } = resolveSendCredentials(wa));
  } catch {
    return; // best effort — mesma postura do .catch abaixo, não interrompe o fluxo
  }

  await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
    }),
  }).catch(() => {
    /* best effort — não interrompe o fluxo se falhar */
  });
}
