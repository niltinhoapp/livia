import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EstablishmentWhatsapp } from "@/types";

vi.mock("@/lib/whatsapp/tokenCrypto", () => ({ decryptToken: () => "server-secret-token" }));

const {
  downloadWhatsAppAudio,
  MAX_INBOUND_AUDIO_BYTES,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  WhatsAppMediaError,
} = await import("./client");

const wa = {
  wabaId: "waba",
  phoneNumberId: "phone-1",
  status: "connected",
  accessToken: { ciphertext: "x", iv: "y", authTag: "z" },
} as EstablishmentWhatsapp;

let fetchMock: ReturnType<typeof vi.fn>;

function lookup(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/abc",
    mime_type: "audio/ogg",
    file_size: 3,
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function media(body: Uint8Array = new Uint8Array([1, 2, 3]), mime = "audio/ogg") {
  return new Response(body.buffer as ArrayBuffer, {
    status: 200,
    headers: { "content-type": mime, "content-length": String(body.byteLength) },
  });
}

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "development");
  fetchMock = vi.fn().mockResolvedValueOnce(lookup()).mockResolvedValueOnce(media());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("downloadWhatsAppAudio", () => {
  it("resolve media_id e baixa o binário autenticado somente no servidor", async () => {
    const result = await downloadWhatsAppAudio(wa, "est-1", "media-1");

    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg", sizeBytes: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toContain("/media-1?phone_number_id=phone-1");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://lookaside.fbsbx.com/whatsapp_business/attachments/abc");
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer server-secret-token" });
    }
    expect(JSON.stringify(result)).not.toContain("server-secret-token");
  });

  it("aceita os MIME de áudio previstos", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(lookup({ mime_type: "audio/mpeg" })).mockResolvedValueOnce(media(new Uint8Array([1]), "audio/mpeg"));
    await expect(downloadWhatsAppAudio(wa, "est-1", "media-1")).resolves.toMatchObject({ mimeType: "audio/mpeg" });
  });

  it("rejeita media_id ausente antes de chamar a Meta", async () => {
    await expect(downloadWhatsAppAudio(wa, "est-1", " ")).rejects.toMatchObject({ code: "missing_media_id" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejeita MIME inválido antes do download", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(lookup({ mime_type: "image/jpeg" }));
    await expect(downloadWhatsAppAudio(wa, "est-1", "media-1")).rejects.toMatchObject({ code: "unsupported_mime" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejeita arquivo vazio", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(lookup({ file_size: undefined })).mockResolvedValueOnce(media(new Uint8Array()));
    await expect(downloadWhatsAppAudio(wa, "est-1", "media-1")).rejects.toMatchObject({ code: "empty_file" });
  });

  it("rejeita tamanho excessivo antes de baixar", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(lookup({ file_size: MAX_INBOUND_AUDIO_BYTES + 1 }));
    await expect(downloadWhatsAppAudio(wa, "est-1", "media-1")).rejects.toMatchObject({ code: "file_too_large" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 429, 500])("trata erro HTTP %i da Meta sem expor corpo", async (status) => {
    fetchMock.mockReset().mockResolvedValueOnce(new Response("sensitive body", { status }));
    await expect(downloadWhatsAppAudio(wa, "est-1", "media-1")).rejects.toMatchObject({
      code: "meta_lookup_failed",
      status,
      message: "meta_lookup_failed",
    });
  });

  it("trata erro no download da URL temporária", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(lookup()).mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(downloadWhatsAppAudio(wa, "est-1", "media-1")).rejects.toMatchObject({ code: "meta_download_failed", status: 404 });
  });

  it("rejeita URL não-Meta sem enviar o token", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(lookup({ url: "https://attacker.example/audio.ogg" }));
    await expect(downloadWhatsAppAudio(wa, "est-1", "media-1")).rejects.toMatchObject({ code: "invalid_media_url" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborta lookup que excede o timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));

    const pending = downloadWhatsAppAudio(wa, "est-1", "media-1");
    const expectation = expect(pending).rejects.toBeInstanceOf(WhatsAppMediaError);
    await vi.advanceTimersByTimeAsync(MEDIA_DOWNLOAD_TIMEOUT_MS + 1);
    await expectation;
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });

  it("aborta leitura do download que excede o timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockResolvedValueOnce(lookup()).mockImplementationOnce((_url: string, init: RequestInit) => {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new Uint8Array([1]));
        },
      });
      init.signal?.addEventListener("abort", () => streamController.error(new DOMException("aborted", "AbortError")));
      return Promise.resolve(new Response(body, { headers: { "content-type": "audio/ogg" } }));
    });

    const pending = downloadWhatsAppAudio(wa, "est-1", "media-1");
    const expectation = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(MEDIA_DOWNLOAD_TIMEOUT_MS + 1);
    await expectation;
  });
});
