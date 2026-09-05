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
// TEMPORÁRIO (gravação do App Review, só Preview): quando as três envs abaixo
// existem E o envio é para o `establishmentId` de teste, usa o número/token
// de teste da Meta em vez do Firestore. As três nunca existem em Production,
// então lá este bloco nunca dispara. E mesmo em Preview, qualquer OUTRO
// estabelecimento (a Odonto real inclusa) segue 100% pelo caminho normal —
// a checagem de `establishmentId` é o que impede o bypass de vazar para
// outro tenant só porque as envs de teste existem no ambiente. O token de
// teste já vem em texto puro da Meta (não é EncryptedToken); segue as MESMAS
// regras de nunca logar/persistir — só usado localmente para montar o header
// Authorization. Remover após a gravação.
function resolveTestCredentials(establishmentId: string): { phoneNumberId: string; accessToken: string } | null {
  const phoneNumberId = process.env.WHATSAPP_TEST_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_TEST_ACCESS_TOKEN;
  const testEstablishmentId = process.env.WHATSAPP_TEST_ESTABLISHMENT_ID;
  if (!phoneNumberId || !accessToken || !testEstablishmentId) return null;
  if (establishmentId !== testEstablishmentId) return null;
  return { phoneNumberId, accessToken };
}

function resolveSendCredentials(
  wa: EstablishmentWhatsapp,
  establishmentId: string,
): {
  phoneNumberId: string;
  accessToken: string;
} {
  const test = resolveTestCredentials(establishmentId);
  if (test) return test;

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
  establishmentId: string,
  toPhone: string,
  text: string,
): Promise<{ waMessageId?: string }> {
  const { phoneNumberId, accessToken } = resolveSendCredentials(wa, establishmentId);
  const to = normalizePhone(toPhone);
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    }),
  });

  // DIAGNÓSTICO TEMPORÁRIO (05/09/2026): a Meta aceita o POST (2xx,
  // messages[0].id presente) mas a mensagem não chega ao celular. Sem ver o
  // status/corpo/id reais, é impossível saber se a Graph API já sinalizou
  // algo (corpo "vazio" com 2xx) ou se o problema é assíncrono, resolvido só
  // por um evento de status posterior (ver processStatus em route.ts). Nunca
  // loga o access token; loga `to`/`phoneNumberId` porque são os únicos dados
  // que provam se o envio foi pro destinatário/canal certo. Remover depois
  // que a causa raiz da não-entrega for confirmada.
  const rawBody = await res.clone().text();
  console.log(
    "[livia whatsapp] sendText debug",
    JSON.stringify({ status: res.status, to, phoneNumberId, body: rawBody.slice(0, 500) }),
  );

  if (!res.ok) {
    throw new Error(`WhatsApp sendText ${res.status}: ${rawBody}`);
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
  establishmentId: string,
  toPhone: string,
  templateName: string,
  languageCode: string,
  params: string[] = [],
): Promise<{ waMessageId?: string }> {
  const { phoneNumberId, accessToken } = resolveSendCredentials(wa, establishmentId);
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

// Extrai só os campos de diagnóstico do erro da Graph API. Nunca devolve o
// corpo cru: o corpo é da Meta e não carrega token, mas despejar texto livre
// em log é exatamente como dado inesperado acaba vazando. `message` vem
// truncada — a mensagem da Meta pode citar o wamid (que o webhook já loga
// como msgId) e nada além disso é necessário para diagnosticar.
function graphErrorDetail(rawBody: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
    };
    const e = parsed.error;
    if (!e) return { parsed: false };
    return {
      code: e.code ?? null,
      subcode: e.error_subcode ?? null,
      type: e.type ?? null,
      message: typeof e.message === "string" ? e.message.slice(0, 200) : null,
      fbtraceId: e.fbtrace_id ?? null,
    };
  } catch {
    // Resposta não-JSON (raro; normalmente HTML de gateway). Só o tamanho.
    return { parsed: false, bodyLength: rawBody.length };
  }
}

// Marca a mensagem recebida como lida (opcional, melhora a UX — o cliente vê
// o "visto" azul enquanto a IA formula a resposta).
//
// Best-effort de propósito: nada aqui pode impedir o think() nem o sendText()
// — marcar como lida é cosmético, responder o cliente não é. O que mudou
// (05/09/2026) é que a falha deixou de ser INVISÍVEL: em Production esta
// chamada vinha devolvendo HTTP 400 e ninguém sabia, porque o código nunca
// checava res.ok nem lia o corpo — o Response era descartado sem ser aberto,
// e o .catch() só pegaria falha de rede (um 400 resolve a promise, não a
// rejeita). Agora o motivo é registrado; o comportamento segue idêntico.
export async function markAsRead(
  wa: EstablishmentWhatsapp,
  establishmentId: string,
  waMessageId: string,
): Promise<void> {
  let phoneNumberId: string;
  let accessToken: string;
  try {
    ({ phoneNumberId, accessToken } = resolveSendCredentials(wa, establishmentId));
  } catch {
    return; // best effort — não interrompe o fluxo
  }

  try {
    const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
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
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        "[livia whatsapp] markAsRead falhou",
        JSON.stringify({ status: res.status, ...graphErrorDetail(body) }),
      );
    }
  } catch (err) {
    // Falha de rede/timeout — segue best-effort, mas agora visível.
    console.warn("[livia whatsapp] markAsRead falhou (rede)", JSON.stringify({ error: String(err).slice(0, 200) }));
  }
}
