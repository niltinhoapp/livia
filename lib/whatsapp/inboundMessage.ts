import type { MessageKind, MessageMedia } from "@/types";

export interface MetaInboundMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  audio?: MetaMedia;
  image?: MetaMedia & { caption?: string };
  document?: MetaMedia & { caption?: string; filename?: string };
  video?: MetaMedia & { caption?: string };
  sticker?: MetaMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
}

interface MetaMedia {
  id?: string;
  mime_type?: string;
  filename?: string;
  sha256?: string;
  file_size?: number;
  voice?: boolean;
}

export interface InboundMessage {
  waMessageId?: string;
  from: string;
  kind: MessageKind;
  text: string;
  media?: MessageMedia;
}

const PLACEHOLDER: Record<Exclude<MessageKind, "text">, string> = {
  audio: "[Áudio recebido]",
  image: "[Imagem recebida]",
  document: "[Documento recebido]",
  video: "[Vídeo recebido]",
  sticker: "[Sticker recebido]",
  location: "[Localização recebida]",
  interactive: "[Interação recebida]",
  unsupported: "[Mensagem não suportada]",
};

function mediaFrom(payload: MetaMedia | undefined): MessageMedia | undefined {
  if (!payload) return undefined;
  const media: MessageMedia = {
    ...(payload.id ? { metaMediaId: payload.id } : {}),
    ...(payload.mime_type ? { mimeType: payload.mime_type } : {}),
    ...(payload.filename ? { filename: payload.filename } : {}),
    ...(payload.sha256 ? { sha256: payload.sha256 } : {}),
    ...(typeof payload.file_size === "number" ? { fileSizeBytes: payload.file_size } : {}),
    ...(typeof payload.voice === "boolean" ? { voice: payload.voice } : {}),
  };
  return Object.keys(media).length > 0 ? media : undefined;
}

function withMedia(
  message: MetaInboundMessage,
  kind: Exclude<MessageKind, "text" | "location" | "interactive" | "unsupported">,
  payload: MetaMedia | undefined,
  caption?: string,
): InboundMessage {
  return {
    waMessageId: message.id,
    from: message.from ?? "",
    kind,
    text: caption?.trim() || PLACEHOLDER[kind],
    ...(mediaFrom(payload) ? { media: mediaFrom(payload) } : {}),
  };
}

// Fronteira controlada entre o payload heterogêneo da Meta e o contrato
// interno. Não faz download nem mantém URLs temporárias/autenticadas.
export function parseInboundMessage(message: MetaInboundMessage): InboundMessage {
  switch (message.type) {
    case "text":
      return typeof message.text?.body === "string" && message.text.body.length > 0
        ? { waMessageId: message.id, from: message.from ?? "", kind: "text", text: message.text.body }
        : { waMessageId: message.id, from: message.from ?? "", kind: "unsupported", text: PLACEHOLDER.unsupported };
    case "audio":
      return withMedia(message, "audio", message.audio);
    case "image":
      return withMedia(message, "image", message.image, message.image?.caption);
    case "document":
      return withMedia(message, "document", message.document, message.document?.caption);
    case "video":
      return withMedia(message, "video", message.video, message.video?.caption);
    case "sticker":
      return withMedia(message, "sticker", message.sticker);
    case "location":
      return { waMessageId: message.id, from: message.from ?? "", kind: "location", text: PLACEHOLDER.location };
    case "interactive": {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
      return {
        waMessageId: message.id,
        from: message.from ?? "",
        kind: "interactive",
        text: reply?.title?.trim() || PLACEHOLDER.interactive,
      };
    }
    default:
      return { waMessageId: message.id, from: message.from ?? "", kind: "unsupported", text: PLACEHOLDER.unsupported };
  }
}
