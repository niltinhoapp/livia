import OpenAI from "openai";

export const SPEECH_PROVIDER = "openai";
export const DEFAULT_SPEECH_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_SPEECH_VOICE = "nova";
export const MAX_TTS_CHARS = 1_200;
export const MAX_TTS_AUDIO_BYTES = 8 * 1024 * 1024;

// Instrução de estilo enviada ao modelo como guia de personalidade vocal.
// Controla tom, ritmo e naturalidade sem custo adicional relevante (~30 tokens
// de input por chamada). Substituível via LIVIA_TTS_INSTRUCTIONS para ajuste
// fino sem redeploy.
export const DEFAULT_SPEECH_INSTRUCTIONS =
  "Speak in Brazilian Portuguese with a natural, warm, and professional female voice. " +
  "Sound like a receptionist chatting casually over WhatsApp — spontaneous, friendly, and clear. " +
  "Use a slightly quicker, flowing pace with short pauses only where natural — avoid dragging between sentences. " +
  "Keep the rhythm light and steady, never rushed but never slow. " +
  "Avoid announcer tone, formal reading style, or mechanical pacing. " +
  "Be warm and confident without being overly enthusiastic.";

export class SpeechError extends Error { constructor(public readonly code: "missing_api_key" | "text_too_long" | "provider_error" | "invalid_audio") { super(code); this.name = "SpeechError"; } }
export async function synthesizeSpeech(text: string): Promise<{ bytes: Uint8Array; mimeType: "audio/ogg"; provider: string; model: string; voice: string }> {
  const input = text.trim();
  if (!input || input.length > MAX_TTS_CHARS) throw new SpeechError("text_too_long");
  const apiKey = process.env.OPENAI_API_KEY?.trim(); if (!apiKey) throw new SpeechError("missing_api_key");
  const model = process.env.LIVIA_TTS_MODEL?.trim() || DEFAULT_SPEECH_MODEL;
  const voice = process.env.LIVIA_TTS_VOICE?.trim() || DEFAULT_SPEECH_VOICE;
  const instructions = process.env.LIVIA_TTS_INSTRUCTIONS?.trim() || DEFAULT_SPEECH_INSTRUCTIONS;
  try {
    const response = await new OpenAI({ apiKey }).audio.speech.create({ model, voice, input, instructions, response_format: "opus", speed: 1.21 } as any, { timeout: 30_000, maxRetries: 0 });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_TTS_AUDIO_BYTES || bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53) throw new SpeechError("invalid_audio");
    return { bytes, mimeType: "audio/ogg", provider: SPEECH_PROVIDER, model, voice };
  } catch (error) { if (error instanceof SpeechError) throw error; throw new SpeechError("provider_error"); }
}
