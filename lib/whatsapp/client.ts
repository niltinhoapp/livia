// Cliente da Meta Cloud API para a Livia.
// Diferença crucial em relação ao Nuvem Rush: aqui é CONVERSA. Quando o
// cliente manda mensagem, abre-se uma janela de 24h em que podemos responder
// com TEXTO LIVRE — sem template aprovado. É isso que o bot usa.
//
// Credenciais vêm SEMPRE do estabelecimento (Embedded Signup / Tech Provider);
// a Meta cobra as conversas direto dele.
import type { EstablishmentWhatsapp } from "@/types";

const GRAPH = "https://graph.facebook.com/v22.0";

// Normaliza pro formato da Graph API (dígitos com DDI). Até 11 dígitos =
// número BR sem DDI -> prefixa 55.
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length <= 11) return `55${digits}`;
  return digits;
}

// Envia texto livre (só válido dentro da janela de 24h aberta pelo cliente).
export async function sendText(
  wa: EstablishmentWhatsapp,
  toPhone: string,
  text: string,
): Promise<{ waMessageId?: string }> {
  const res = await fetch(`${GRAPH}/${wa.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${wa.accessToken}`,
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
  const components =
    params.length > 0
      ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
      : undefined;

  const res = await fetch(`${GRAPH}/${wa.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${wa.accessToken}`,
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
  await fetch(`${GRAPH}/${wa.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${wa.accessToken}`,
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
