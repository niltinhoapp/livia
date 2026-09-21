import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EstablishmentWhatsapp } from "@/types";

vi.mock("@/lib/whatsapp/tokenCrypto", () => ({ decryptToken: () => "server-secret-token" }));

const { sendAudio } = await import("./client");

const wa = {
  wabaId: "waba",
  phoneNumberId: "phone-1",
  status: "connected",
  accessToken: { ciphertext: "x", iv: "y", authTag: "z" },
} as EstablishmentWhatsapp;
const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1]);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "media-1" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "wamid.audio" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VERCEL_ENV", "development");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("sendAudio", () => {
  it("faz upload multipart Ogg e envia o payload oficial de áudio", async () => {
    await expect(sendAudio(wa, "est-1", "(14) 99123-4567", ogg)).resolves.toEqual({ waMessageId: "wamid.audio" });
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(uploadUrl).toContain("/phone-1/media");
    expect(uploadInit).toMatchObject({ method: "POST", headers: { Authorization: "Bearer server-secret-token" } });
    expect(uploadInit.body).toBeInstanceOf(FormData);
    const form = uploadInit.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    const file = form.get("file") as File;
    expect(file).toBeInstanceOf(Blob); expect(file.type).toBe("audio/ogg"); expect(file.name).toBe("reply.ogg");

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toContain("/phone-1/messages");
    expect(sendInit).toMatchObject({ method: "POST", headers: { Authorization: "Bearer server-secret-token", "Content-Type": "application/json" } });
    expect(JSON.parse(String(sendInit.body))).toEqual({ messaging_product: "whatsapp", to: "5514991234567", type: "audio", audio: { id: "media-1" } });
  });

  it.each([400, 401, 500])("classifica rejeição HTTP de upload (%i) como segura para fallback", async (status) => {
    fetchMock.mockReset().mockResolvedValueOnce(new Response("no", { status }));
    await expect(sendAudio(wa, "est-1", "5514991234567", ogg)).rejects.toMatchObject({ code: "audio_upload_failed", safeTextFallback: true, status });
  });

  it("classifica rede no upload sem tentar enviar mensagem", async () => {
    fetchMock.mockReset().mockRejectedValueOnce(new TypeError("network"));
    await expect(sendAudio(wa, "est-1", "5514991234567", ogg)).rejects.toMatchObject({ code: "audio_upload_ambiguous", safeTextFallback: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejeita resposta de upload sem mediaId", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await expect(sendAudio(wa, "est-1", "5514991234567", ogg)).rejects.toMatchObject({ code: "audio_upload_failed", safeTextFallback: true });
  });

  it.each([400, 403, 500])("classifica rejeição HTTP de envio (%i) como segura para fallback", async (status) => {
    fetchMock.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({ id: "media-1" }), { status: 200 })).mockResolvedValueOnce(new Response("no", { status }));
    await expect(sendAudio(wa, "est-1", "5514991234567", ogg)).rejects.toMatchObject({ code: "audio_send_failed", safeTextFallback: true, status });
  });

  it("classifica timeout/rede após POST /messages como ambíguo e proíbe fallback", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({ id: "media-1" }), { status: 200 })).mockRejectedValueOnce(new TypeError("network"));
    await expect(sendAudio(wa, "est-1", "5514991234567", ogg)).rejects.toMatchObject({
      name: "WhatsAppAudioSendError", code: "audio_send_ambiguous", safeTextFallback: false,
    });
  });

  it("não tenta upload quando Ogg é inválido", async () => {
    await expect(sendAudio(wa, "est-1", "5514991234567", new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "unsupported_mime" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
