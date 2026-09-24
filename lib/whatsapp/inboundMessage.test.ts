import { describe, expect, it } from "vitest";
import { parseInboundMessage } from "@/lib/whatsapp/inboundMessage";

const base = { id: "wamid.1", from: "5514991234567" };

describe("parseInboundMessage", () => {
  it("preserva texto sem alteração", () => {
    expect(parseInboundMessage({ ...base, type: "text", text: { body: "Olá, Lívia" } })).toMatchObject({
      kind: "text",
      text: "Olá, Lívia",
      waMessageId: "wamid.1",
    });
  });

  it("normaliza áudio de voz com metadados seguros", () => {
    expect(parseInboundMessage({
      ...base,
      type: "audio",
      audio: { id: "media.audio", mime_type: "audio/ogg", sha256: "hash", file_size: 42, voice: true },
    })).toEqual({
      waMessageId: "wamid.1", from: base.from, kind: "audio", text: "[Áudio recebido]",
      media: { metaMediaId: "media.audio", mimeType: "audio/ogg", sha256: "hash", fileSizeBytes: 42, voice: true },
    });
  });

  it("normaliza áudio que não é voz", () => {
    expect(parseInboundMessage({ ...base, type: "audio", audio: { id: "media.file", voice: false } })).toMatchObject({
      kind: "audio", text: "[Áudio recebido]", media: { metaMediaId: "media.file", voice: false },
    });
  });

  it("preserva caption de imagem sem reter URL", () => {
    const parsed = parseInboundMessage({
      ...base, type: "image",
      image: { id: "media.image", mime_type: "image/jpeg", caption: "Olha isso", sha256: "hash", file_size: 1024 },
    } as never);
    expect(parsed).toMatchObject({ kind: "image", text: "Olha isso", media: { metaMediaId: "media.image", mimeType: "image/jpeg" } });
    expect(JSON.stringify(parsed)).not.toContain("https://graph.facebook.com/");
  });

  it.each([
    ["document", "[Documento recebido]"],
    ["video", "[Vídeo recebido]"],
    ["sticker", "[Sticker recebido]"],
  ] as const)("normaliza %s", (type, text) => {
    const parsed = parseInboundMessage({ ...base, type, [type]: { id: `media.${type}`, mime_type: "application/test" } });
    expect(parsed).toMatchObject({ kind: type, text, media: { metaMediaId: `media.${type}` } });
  });

  it("preserva apenas o filename do documento para o painel", () => {
    const parsed = parseInboundMessage({
      ...base,
      type: "document",
      document: { id: "media.document", mime_type: "application/pdf", filename: "laudo.pdf" },
    });
    expect(parsed.media).toMatchObject({ metaMediaId: "media.document", filename: "laudo.pdf" });
  });

  it("normaliza localização sem coordenadas ou endereço", () => {
    expect(parseInboundMessage({ ...base, type: "location", location: { latitude: -22.3, longitude: -49.0 } })).toMatchObject({
      kind: "location", text: "[Localização recebida]",
    });
  });

  it("normaliza botão interativo pelo título exibível", () => {
    expect(parseInboundMessage({
      ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "secret-id", title: "Confirmar" } },
    })).toMatchObject({ kind: "interactive", text: "Confirmar" });
  });

  it("preserva os metadados técnicos mínimos de payload unsupported", () => {
    expect(parseInboundMessage({
      ...base,
      type: "future_type",
      unsupported: { type: "unsupported_message" },
      errors: [{ code: 131051 }],
    })).toEqual({
      waMessageId: "wamid.1", from: base.from, kind: "unsupported", text: "[Mensagem não suportada]",
      metaType: "future_type", unsupportedType: "unsupported_message", metaErrorCode: 131051,
    });
  });

  it("normaliza payload unsupported sem metadados opcionais", () => {
    expect(parseInboundMessage({ type: "future_type" })).toEqual({
      waMessageId: undefined, from: "", kind: "unsupported", text: "[Mensagem não suportada]", metaType: "future_type",
    });
    expect(parseInboundMessage({ ...base, type: "text" })).toEqual({
      waMessageId: "wamid.1", from: base.from, kind: "unsupported", text: "[Mensagem não suportada]", metaType: "text",
    });
  });

  it("nunca expõe URL presente acidentalmente no payload", () => {
    const parsed = parseInboundMessage({
      ...base, type: "audio",
      audio: { id: "media.audio", mime_type: "audio/ogg", url: "https://graph.facebook.com/temporary-token" },
    } as never);
    expect(JSON.stringify(parsed)).not.toContain("temporary-token");
  });
});
