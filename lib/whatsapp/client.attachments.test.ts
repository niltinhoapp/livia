import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EstablishmentWhatsapp } from "@/types";

vi.mock("@/lib/whatsapp/tokenCrypto", () => ({ decryptToken: () => "server-secret-token" }));

const { downloadWhatsAppMedia, MAX_INBOUND_ATTACHMENT_BYTES } = await import("./client");

const wa = {
  wabaId: "waba", phoneNumberId: "phone-1", status: "connected",
  accessToken: { ciphertext: "x", iv: "y", authTag: "z" },
} as EstablishmentWhatsapp;

let fetchMock: ReturnType<typeof vi.fn>;

function lookup(mimeType: string, fileSize: number) {
  return new Response(JSON.stringify({
    url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/abc",
    mime_type: mimeType,
    file_size: fileSize,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function media(bytes: number[], mimeType: string) {
  const body = Uint8Array.from(bytes);
  return new Response(body.buffer, {
    status: 200,
    headers: { "content-type": mimeType, "content-length": String(body.byteLength) },
  });
}

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "development");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("download de anexos da Meta", () => {
  it("aceita JPEG válido e autentica as duas chamadas no servidor", async () => {
    fetchMock.mockResolvedValueOnce(lookup("image/jpeg", 4)).mockResolvedValueOnce(media([0xff, 0xd8, 0xff, 0x00], "image/jpeg"));
    await expect(downloadWhatsAppMedia(wa, "est_a", "media-1", "image")).resolves.toMatchObject({ mimeType: "image/jpeg", sizeBytes: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({ Authorization: "Bearer server-secret-token" });
  });

  it("aceita PDF válido", async () => {
    fetchMock.mockResolvedValueOnce(lookup("application/pdf", 6)).mockResolvedValueOnce(media([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31], "application/pdf"));
    await expect(downloadWhatsAppMedia(wa, "est_a", "media-2", "document")).resolves.toMatchObject({ mimeType: "application/pdf" });
  });

  it("rejeita MIME não permitido antes de baixar", async () => {
    fetchMock.mockResolvedValueOnce(lookup("text/html", 10));
    await expect(downloadWhatsAppMedia(wa, "est_a", "media-3", "document")).rejects.toMatchObject({ code: "unsupported_mime" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejeita conteúdo cuja assinatura não corresponde ao MIME", async () => {
    fetchMock.mockResolvedValueOnce(lookup("application/pdf", 4)).mockResolvedValueOnce(media([1, 2, 3, 4], "application/pdf"));
    await expect(downloadWhatsAppMedia(wa, "est_a", "media-4", "document")).rejects.toMatchObject({ code: "unsupported_mime" });
  });

  it("rejeita tamanho excessivo antes do download", async () => {
    fetchMock.mockResolvedValueOnce(lookup("image/png", MAX_INBOUND_ATTACHMENT_BYTES + 1));
    await expect(downloadWhatsAppMedia(wa, "est_a", "media-5", "image")).rejects.toMatchObject({ code: "file_too_large" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
