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
import { getWhatsappTestCredentials } from "@/lib/whatsapp/testCredentials";
import type { EstablishmentWhatsapp } from "@/types";

const GRAPH = "https://graph.facebook.com/v22.0";

export const MAX_INBOUND_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_INBOUND_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;
export const MESSAGE_TEMPLATES_PAGE_LIMIT = 10;

const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/amr",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
]);

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export type DownloadableWhatsAppMediaKind = "audio" | "image" | "document";

export type WhatsAppMediaErrorCode =
  | "missing_media_id"
  | "meta_lookup_failed"
  | "invalid_meta_response"
  | "invalid_media_url"
  | "meta_download_failed"
  | "unsupported_mime"
  | "empty_file"
  | "file_too_large"
  | "timeout"
  | "network_error";

export class WhatsAppMediaError extends Error {
  constructor(
    public readonly code: WhatsAppMediaErrorCode,
    public readonly status?: number,
  ) {
    super(code);
    this.name = "WhatsAppMediaError";
  }
}

export type MetaTemplateComponent = {
  type: string;
  format?: string;
  text?: string;
  buttons?: unknown[];
  example?: unknown;
  [key: string]: unknown;
};

export type WhatsAppTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components: MetaTemplateComponent[];
  approved: boolean;
  senderCompatible: boolean;
};

function componentHasTemplateVariable(component: MetaTemplateComponent): boolean {
  return /\{\{\s*[^}]+\s*\}\}/.test(JSON.stringify(component));
}

/** O sender só precisa enviar componentes que possuam parâmetros. Cabeçalho
 * de texto, rodapé e botões estáticos já fazem parte do template aprovado e
 * são renderizados pela própria Meta sem repetir seu conteúdo no payload. */
export function templateComponentsAreSenderCompatible(components: MetaTemplateComponent[]): boolean {
  return components.every((component) => {
    const type = component.type.toUpperCase();
    if (type === "BODY") return true;
    if (type === "FOOTER") return !componentHasTemplateVariable(component);
    if (type === "BUTTONS") return !componentHasTemplateVariable(component);
    if (type === "HEADER") {
      const format = String(component.format ?? "TEXT").toUpperCase();
      return format === "TEXT" && !componentHasTemplateVariable(component);
    }
    return false;
  });
}

export class WhatsAppTemplateError extends Error {
  constructor(public readonly code: "not_connected" | "missing_waba" | "meta_error" | "invalid_response" | "timeout" | "network_error", public readonly status?: number) {
    super(code);
    this.name = "WhatsAppTemplateError";
  }
}

export interface DownloadedWhatsAppMedia {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
}

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
// existem em Preview (ou nos testes) E o envio é para o `establishmentId` de
// teste, usa o número/token de teste da Meta em vez do Firestore. Production,
// desenvolvimento local e ambientes desconhecidos nunca ativam esse bloco.
// Mesmo em Preview, qualquer OUTRO
// estabelecimento (a Odonto real inclusa) segue 100% pelo caminho normal —
// a checagem de `establishmentId` é o que impede o bypass de vazar para
// outro tenant só porque as envs de teste existem no ambiente. O token de
// teste já vem em texto puro da Meta (não é EncryptedToken); segue as MESMAS
// regras de nunca logar/persistir — só usado localmente para montar o header
// Authorization. Remover após a gravação.
function resolveTestCredentials(establishmentId: string): { phoneNumberId: string; accessToken: string } | null {
  const test = getWhatsappTestCredentials();
  if (!test || establishmentId !== test.establishmentId) return null;
  return test;
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

function baseMimeType(value: string | null | undefined): string | null {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime || null;
}

function allowedMimeTypes(kind: DownloadableWhatsAppMediaKind): Set<string> {
  if (kind === "audio") return ALLOWED_AUDIO_MIME_TYPES;
  if (kind === "image") return ALLOWED_IMAGE_MIME_TYPES;
  return ALLOWED_DOCUMENT_MIME_TYPES;
}

function assertAllowedMime(value: string | null | undefined, kind: DownloadableWhatsAppMediaKind): string {
  const mime = baseMimeType(value);
  if (!mime || !allowedMimeTypes(kind).has(mime)) {
    throw new WhatsAppMediaError("unsupported_mime");
  }
  return mime;
}

function isAllowedMetaMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host === "lookaside.fbsbx.com" ||
      host.endsWith(".facebook.com") ||
      host.endsWith(".fbcdn.net") ||
      host.endsWith(".fbsbx.com") ||
      host.endsWith(".whatsapp.net")
    );
  } catch {
    return false;
  }
}

async function withMediaTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (err) {
    if (err instanceof WhatsAppMediaError) throw err;
    if (controller.signal.aborted) throw new WhatsAppMediaError("timeout");
    throw new WhatsAppMediaError("network_error");
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new WhatsAppMediaError("file_too_large");
  }

  if (!response.body) throw new WhatsAppMediaError("empty_file");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WhatsAppMediaError("file_too_large");
    }
    chunks.push(value);
  }
  if (total === 0) throw new WhatsAppMediaError("empty_file");

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Fluxo oficial da Cloud API: resolve o media_id em uma URL temporária e
// baixa essa URL com o mesmo Bearer token. O binário só existe em memória e
// nunca é devolvido ao browser, persistido ou logado.
function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function validateMediaSignature(bytes: Uint8Array, mimeType: string): void {
  const valid =
    mimeType === "image/jpeg" ? hasPrefix(bytes, [0xff, 0xd8, 0xff]) :
    mimeType === "image/png" ? hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) :
    mimeType === "application/pdf" ? hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) :
    mimeType.includes("openxmlformats-officedocument") ? hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) :
    ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(mimeType)
      ? hasPrefix(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
      : true;
  if (!valid) throw new WhatsAppMediaError("unsupported_mime");
}

export async function downloadWhatsAppMedia(
  wa: EstablishmentWhatsapp,
  establishmentId: string,
  mediaId: string,
  kind: DownloadableWhatsAppMediaKind,
): Promise<DownloadedWhatsAppMedia> {
  if (!mediaId.trim()) throw new WhatsAppMediaError("missing_media_id");
  const { phoneNumberId, accessToken } = resolveSendCredentials(wa, establishmentId);
  const authorization = { Authorization: `Bearer ${accessToken}` };
  const lookupUrl = `${GRAPH}/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(phoneNumberId)}`;

  const metadata = await withMediaTimeout(async (signal) => {
    const lookup = await fetch(lookupUrl, { headers: authorization, signal });
    if (!lookup.ok) throw new WhatsAppMediaError("meta_lookup_failed", lookup.status);
    return (await lookup.json().catch(() => null)) as
      | { url?: unknown; mime_type?: unknown; file_size?: unknown }
      | null;
  });
  if (!metadata || typeof metadata.url !== "string") {
    throw new WhatsAppMediaError("invalid_meta_response");
  }
  if (!isAllowedMetaMediaUrl(metadata.url)) throw new WhatsAppMediaError("invalid_media_url");

  const declaredSize = typeof metadata.file_size === "number" ? metadata.file_size : null;
  const maxBytes = kind === "audio" ? MAX_INBOUND_AUDIO_BYTES : MAX_INBOUND_ATTACHMENT_BYTES;
  if (declaredSize !== null && declaredSize > maxBytes) {
    throw new WhatsAppMediaError("file_too_large");
  }
  if (declaredSize === 0) throw new WhatsAppMediaError("empty_file");
  const declaredMime =
    typeof metadata.mime_type === "string" ? assertAllowedMime(metadata.mime_type, kind) : null;

  return withMediaTimeout(async (signal) => {
    const download = await fetch(metadata.url as string, { headers: authorization, signal });
    if (!download.ok) throw new WhatsAppMediaError("meta_download_failed", download.status);
    const responseMime = assertAllowedMime(download.headers.get("content-type") ?? declaredMime, kind);
    if (declaredMime && responseMime !== declaredMime) {
      throw new WhatsAppMediaError("unsupported_mime");
    }
    const bytes = await readLimitedBody(download, maxBytes);
    if (kind !== "audio") validateMediaSignature(bytes, responseMime);
    return { bytes, mimeType: responseMime, sizeBytes: bytes.byteLength };
  });
}

export async function downloadWhatsAppAudio(
  wa: EstablishmentWhatsapp,
  establishmentId: string,
  mediaId: string,
): Promise<DownloadedWhatsAppMedia> {
  return downloadWhatsAppMedia(wa, establishmentId, mediaId, "audio");
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

  if (!res.ok) {
    const detail = graphErrorDetail(await res.clone().text());
    throw new Error(`WhatsApp sendText falhou: ${JSON.stringify({ status: res.status, ...detail })}`);
  }
  const data = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
  };
  return { waMessageId: data.messages?.[0]?.id };
}

// TTS sempre gera Ogg/Opus: formato compacto e reproduzível nativamente pelo
// WhatsApp. O binário só existe em memória durante upload; nunca é logado.
export async function sendAudio(
  wa: EstablishmentWhatsapp,
  establishmentId: string,
  toPhone: string,
  bytes: Uint8Array,
  mimeType = "audio/ogg",
): Promise<{ waMessageId?: string }> {
  if (!ALLOWED_AUDIO_MIME_TYPES.has(mimeType) || !bytes.length || bytes.length > MAX_INBOUND_AUDIO_BYTES) throw new WhatsAppMediaError("unsupported_mime");
  const { phoneNumberId, accessToken } = resolveSendCredentials(wa, establishmentId);
  const form = new FormData(); const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; form.set("messaging_product", "whatsapp"); form.set("file", new Blob([body], { type: mimeType }), "reply.ogg");
  const upload = await fetch(`${GRAPH}/${phoneNumberId}/media`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form });
  if (!upload.ok) throw new Error(`WhatsApp audio upload failed: ${upload.status}`);
  const mediaId = (await upload.json().catch(() => ({})) as { id?: string }).id;
  if (!mediaId) throw new Error("WhatsApp audio upload invalid response");
  const response = await fetch(`${GRAPH}/${phoneNumberId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", to: normalizePhone(toPhone), type: "audio", audio: { id: mediaId } }) });
  if (!response.ok) throw new Error(`WhatsApp audio send failed: ${response.status}`);
  const data = (await response.json().catch(() => ({}))) as { messages?: { id: string }[] };
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
    const detail = graphErrorDetail(await res.text());
    throw new Error(`WhatsApp sendTemplate falhou: ${JSON.stringify({ status: res.status, ...detail })}`);
  }
  const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[] };
  return { waMessageId: data.messages?.[0]?.id };
}

/** Lista templates da WABA do próprio estabelecimento, sem persistir nem
 * devolver credenciais. APPROVED e compatibilidade do sender são sinais
 * distintos: o sender atual só monta BODY/text parameters. */
export async function listMessageTemplates(
  wa: EstablishmentWhatsapp,
  establishmentId: string,
): Promise<WhatsAppTemplate[]> {
  if (wa.status !== "connected") throw new WhatsAppTemplateError("not_connected");
  if (!wa.wabaId?.trim()) throw new WhatsAppTemplateError("missing_waba");
  const { accessToken } = resolveSendCredentials(wa, establishmentId);
  const headers = { Authorization: `Bearer ${accessToken}` };
  let nextUrl = `${GRAPH}/${encodeURIComponent(wa.wabaId)}/message_templates?fields=id,name,language,status,category,components&limit=100`;
  const result: WhatsAppTemplate[] = [];
  for (let page = 0; page < MESSAGE_TEMPLATES_PAGE_LIMIT && nextUrl; page++) {
    const response = await withTemplateTimeout((signal) => fetch(nextUrl, { headers, signal }));
    if (!response.ok) throw new WhatsAppTemplateError("meta_error", response.status);
    const payload = (await response.json().catch(() => null)) as {
      data?: unknown;
      paging?: { next?: unknown };
    } | null;
    if (!payload || !Array.isArray(payload.data)) throw new WhatsAppTemplateError("invalid_response");
    for (const raw of payload.data) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.language !== "string" || typeof item.status !== "string") continue;
      const components = Array.isArray(item.components)
        ? item.components.filter((component): component is MetaTemplateComponent => !!component && typeof component === "object" && typeof (component as Record<string, unknown>).type === "string")
        : [];
      const status = item.status.toUpperCase();
      result.push({
        id: item.id,
        name: item.name,
        language: item.language,
        status: item.status,
        ...(typeof item.category === "string" ? { category: item.category } : {}),
        components,
        approved: status === "APPROVED",
        senderCompatible: templateComponentsAreSenderCompatible(components),
      });
    }
    nextUrl = typeof payload.paging?.next === "string" && isAllowedMetaApiUrl(payload.paging.next) ? payload.paging.next : "";
  }
  return result;
}

async function withTemplateTimeout(operation: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (error instanceof WhatsAppTemplateError) throw error;
    if (controller.signal.aborted) throw new WhatsAppTemplateError("timeout");
    throw new WhatsAppTemplateError("network_error");
  } finally {
    clearTimeout(timeout);
  }
}

function isAllowedMetaApiUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "graph.facebook.com";
  } catch {
    return false;
  }
}

// Extrai só os campos de diagnóstico do erro da Graph API. Nunca devolve o
// corpo cru: o corpo é da Meta e não carrega token, mas despejar texto livre
// em log é exatamente como dado inesperado acaba vazando. Só status/códigos
// estruturados e fbtrace_id são úteis para diagnóstico.
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
    // Falha de rede/timeout — segue best-effort, mas agora visível sem expor
    // texto livre vindo de bibliotecas/intermediários HTTP.
    console.warn("[livia whatsapp] markAsRead falhou (rede)", JSON.stringify({
      errorType: err instanceof Error ? err.name : "unknown",
    }));
  }
}
