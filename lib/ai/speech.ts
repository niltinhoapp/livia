import OpenAI from "openai";

export const SPEECH_PROVIDER = "openai";
export const DEFAULT_SPEECH_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_SPEECH_VOICE = "coral";
export const MAX_TTS_CHARS = 1_200;
export const MAX_TTS_AUDIO_BYTES = 8 * 1024 * 1024;

export class SpeechError extends Error { constructor(public readonly code: "missing_api_key" | "text_too_long" | "provider_error" | "invalid_audio") { super(code); this.name = "SpeechError"; } }
export async function synthesizeSpeech(text: string): Promise<{ bytes: Uint8Array; mimeType: "audio/ogg"; provider: string; model: string; voice: string }> {
  const input = text.trim();
  if (!input || input.length > MAX_TTS_CHARS) throw new SpeechError("text_too_long");
  const apiKey = process.env.OPENAI_API_KEY?.trim(); if (!apiKey) throw new SpeechError("missing_api_key");
  const model = process.env.LIVIA_TTS_MODEL?.trim() || DEFAULT_SPEECH_MODEL;
  const voice = process.env.LIVIA_TTS_VOICE?.trim() || DEFAULT_SPEECH_VOICE;
  try {
    const response = await new OpenAI({ apiKey }).audio.speech.create({ model, voice, input, response_format: "opus" }, { timeout: 30_000, maxRetries: 0 });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_TTS_AUDIO_BYTES) throw new SpeechError("invalid_audio");
    return { bytes, mimeType: "audio/ogg", provider: SPEECH_PROVIDER, model, voice };
  } catch (error) { if (error instanceof SpeechError) throw error; throw new SpeechError("provider_error"); }
}
