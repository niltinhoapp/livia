import OpenAI, { toFile } from "openai";

export const TRANSCRIPTION_PROVIDER = "openai";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const TRANSCRIPTION_TIMEOUT_MS = 30_000;

export type AudioTranscriptionErrorCode =
  | "missing_api_key"
  | "unsupported_mime"
  | "provider_error"
  | "empty_transcript";

export class AudioTranscriptionError extends Error {
  constructor(public readonly code: AudioTranscriptionErrorCode) {
    super(code);
    this.name = "AudioTranscriptionError";
  }
}

export interface AudioTranscriptionResult {
  text: string;
  provider: typeof TRANSCRIPTION_PROVIDER;
  model: string;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

export async function transcribeAudio(input: {
  bytes: Uint8Array;
  mimeType: string;
}): Promise<AudioTranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new AudioTranscriptionError("missing_api_key");

  const extension = EXTENSION_BY_MIME[input.mimeType];
  if (!extension) throw new AudioTranscriptionError("unsupported_mime");
  const model = process.env.LIVIA_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL;

  try {
    const openai = new OpenAI({ apiKey });
    const file = await toFile(input.bytes, `audio.${extension}`, { type: input.mimeType });
    const result = await openai.audio.transcriptions.create(
      { file, model, response_format: "json" },
      { timeout: TRANSCRIPTION_TIMEOUT_MS, maxRetries: 0 },
    );
    const text = result.text.replace(/\s+/g, " ").trim();
    if (!text) throw new AudioTranscriptionError("empty_transcript");
    return { text, provider: TRANSCRIPTION_PROVIDER, model };
  } catch (err) {
    if (err instanceof AudioTranscriptionError) throw err;
    throw new AudioTranscriptionError("provider_error");
  }
}
