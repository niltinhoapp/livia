import type { Message } from "@/types";

const MEDIA_MARKERS: Record<Exclude<NonNullable<Message["kind"]>, "text" | "audio">, string> = {
  image: "[Imagem recebida]",
  document: "[Documento recebido]",
  video: "[Vídeo recebido]",
  sticker: "[Sticker recebido]",
  location: "[Localização recebida]",
  interactive: "[Interação recebida]",
  unsupported: "[Mensagem não suportada]",
};

// Mantém textos V1 e textos V2 byte a byte como antes. Mídias nunca deixam
// conteúdo vazio no histórico, e áudio só passa a fornecer texto após V2.1.
export function contentForAI(message: Message): string {
  if (!message.kind || message.kind === "text") return message.text;
  if (message.kind === "audio") {
    return message.transcription?.status === "completed" && message.transcription.text?.trim()
      ? message.transcription.text
      : "[Áudio recebido — transcrição indisponível]";
  }
  return MEDIA_MARKERS[message.kind];
}
