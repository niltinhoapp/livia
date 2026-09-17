import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const toFile = vi.fn(async (_bytes: Uint8Array, name: string, options: { type: string }) => ({ name, type: options.type }));

vi.mock("openai", () => ({
  default: class {
    audio = { transcriptions: { create } };
  },
  toFile,
}));

const {
  transcribeAudio,
  DEFAULT_TRANSCRIPTION_MODEL,
  TRANSCRIPTION_TIMEOUT_MS,
} = await import("./transcription");

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  create.mockResolvedValue({ text: "  Quero   marcar amanhã às dez.  " });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("transcribeAudio", () => {
  it("chama a transcrição uma vez e normaliza o texto", async () => {
    const result = await transcribeAudio({ bytes: new Uint8Array([1, 2]), mimeType: "audio/ogg" });

    expect(result).toEqual({ text: "Quero marcar amanhã às dez.", provider: "openai", model: DEFAULT_TRANSCRIPTION_MODEL });
    expect(toFile).toHaveBeenCalledWith(expect.any(Uint8Array), "audio.ogg", { type: "audio/ogg" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_TRANSCRIPTION_MODEL, response_format: "json" }),
      { timeout: TRANSCRIPTION_TIMEOUT_MS, maxRetries: 0 },
    );
  });

  it("respeita modelo configurável sem trocar o modelo conversacional", async () => {
    vi.stubEnv("LIVIA_TRANSCRIPTION_MODEL", "gpt-4o-transcribe");
    await transcribeAudio({ bytes: new Uint8Array([1]), mimeType: "audio/mpeg" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4o-transcribe" }), expect.anything());
  });

  it("falha fechado sem OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", " ");
    await expect(transcribeAudio({ bytes: new Uint8Array([1]), mimeType: "audio/ogg" })).rejects.toMatchObject({ code: "missing_api_key" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejeita MIME não mapeado antes do provider", async () => {
    await expect(transcribeAudio({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" })).rejects.toMatchObject({ code: "unsupported_mime" });
    expect(create).not.toHaveBeenCalled();
  });

  it("transcript vazio é falha e nunca vira entrada conversacional", async () => {
    create.mockResolvedValueOnce({ text: "  \n " });
    await expect(transcribeAudio({ bytes: new Uint8Array([1]), mimeType: "audio/ogg" })).rejects.toMatchObject({ code: "empty_transcript" });
  });

  it("sanitiza falha do provider", async () => {
    create.mockRejectedValueOnce(new Error("secret provider detail"));
    await expect(transcribeAudio({ bytes: new Uint8Array([1]), mimeType: "audio/ogg" })).rejects.toMatchObject({
      code: "provider_error",
      message: "provider_error",
    });
  });
});
