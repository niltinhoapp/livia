import { beforeEach, describe, expect, it, vi } from "vitest";
const create = vi.fn();
vi.mock("openai", () => ({ default: class { audio = { speech: { create } }; } }));
import { DEFAULT_SPEECH_INSTRUCTIONS, DEFAULT_SPEECH_VOICE, MAX_TTS_CHARS, SpeechError, synthesizeSpeech } from "./speech";

const OGG_BYTES = [0x4f, 0x67, 0x67, 0x53, 1];
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("OPENAI_API_KEY", "test-key"); create.mockResolvedValue({ arrayBuffer: async () => new Uint8Array(OGG_BYTES).buffer }); });

describe("synthesizeSpeech", () => {
  it("usa voz nova e envia instructions por padrão", async () => {
    await synthesizeSpeech("Olá!");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "nova", instructions: DEFAULT_SPEECH_INSTRUCTIONS }),
      expect.anything(),
    );
  });

  it("converte exatamente o texto final para Ogg/Opus com modelo correto", async () => {
    await expect(synthesizeSpeech("Resposta final")).resolves.toMatchObject({ mimeType: "audio/ogg", model: "gpt-4o-mini-tts", voice: "nova" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ input: "Resposta final", response_format: "opus" }), expect.anything());
  });

  it("LIVIA_TTS_VOICE substitui a voz padrão", async () => {
    vi.stubEnv("LIVIA_TTS_VOICE", "shimmer");
    await synthesizeSpeech("Teste");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ voice: "shimmer" }), expect.anything());
  });

  it("LIVIA_TTS_INSTRUCTIONS substitui o texto padrão das instructions", async () => {
    vi.stubEnv("LIVIA_TTS_INSTRUCTIONS", "Custom instruction");
    await synthesizeSpeech("Teste");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ instructions: "Custom instruction" }), expect.anything());
  });

  it("limita texto e sanitiza erro do provider", async () => {
    await expect(synthesizeSpeech("x".repeat(MAX_TTS_CHARS + 1))).rejects.toBeInstanceOf(SpeechError);
    create.mockRejectedValueOnce(new Error("secret"));
    await expect(synthesizeSpeech("ok")).rejects.toMatchObject({ code: "provider_error" });
  });

  it("rejeita resposta que não seja container Ogg antes do upload", async () => {
    create.mockResolvedValueOnce({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    await expect(synthesizeSpeech("ok")).rejects.toMatchObject({ code: "invalid_audio" });
  });
});
