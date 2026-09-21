import { beforeEach, describe, expect, it, vi } from "vitest";
const create = vi.fn();
vi.mock("openai", () => ({ default: class { audio = { speech: { create } }; } }));
import { MAX_TTS_CHARS, SpeechError, synthesizeSpeech } from "./speech";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("OPENAI_API_KEY", "test-key"); create.mockResolvedValue({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }); });
describe("synthesizeSpeech", () => {
  it("converte exatamente o texto final para Ogg/Opus", async () => { await expect(synthesizeSpeech("Resposta final")).resolves.toMatchObject({ mimeType: "audio/ogg", model: "gpt-4o-mini-tts" }); expect(create).toHaveBeenCalledWith(expect.objectContaining({ input: "Resposta final", response_format: "opus" }), expect.anything()); });
  it("limita texto e sanitiza erro do provider", async () => { await expect(synthesizeSpeech("x".repeat(MAX_TTS_CHARS + 1))).rejects.toBeInstanceOf(SpeechError); create.mockRejectedValueOnce(new Error("secret")); await expect(synthesizeSpeech("ok")).rejects.toMatchObject({ code: "provider_error" }); });
});
