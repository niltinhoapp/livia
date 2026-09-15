// AI Gateway — ponto único de UMA chamada ao modelo (OT-06B).
//
// Refatoração transparente: antes, brain.ts e summarize.ts instanciavam cada
// um o seu cliente OpenAI e liam LIVIA_MODEL por conta própria. Agora ambos
// chamam runCompletion(), que monta exatamente o mesmo request de antes.
//
// Deliberadamente fora deste módulo:
//   - o tool loop (continua em brain.ts, entrelaçado com guards de domínio);
//   - timeout, retries customizados, telemetria, fallback, roteamento de
//     modelo, override por tenant — cada um é uma OT própria.
//
// O cliente continua vindo do módulo "openai" importado aqui: é isso que
// mantém válidos, sem edição, os testes que fazem vi.mock("openai").
import OpenAI from "openai";
import { chatCompletionCompatibilityParams } from "@/lib/ai/openaiCompatibility";

// Resolvidos no carregamento do módulo, como antes em cada call site — mesma
// semântica, agora sem duplicação.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.LIVIA_MODEL ?? "gpt-4o-mini";

// Hoje só identifica a origem da chamada. Não escolhe modelo nem altera
// parâmetros — é a fundação para telemetria/roteamento futuros.
export type AiPurpose = "reception" | "summary";

export interface CompletionRequest {
  purpose: AiPurpose;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  // Só é enviado ao provider quando não vazio: a API rejeita `tools: []`,
  // e brain.ts já evitava enviar a chave nesse caso.
  tools?: OpenAI.Chat.ChatCompletionTool[];
  temperature: number;
  maxOutputTokens: number;
}

// Sem try/catch de propósito: erro do provider propaga para o chamador, que
// mantém a própria semântica (brain.ts propaga; summarize.ts engole).
export async function runCompletion(
  request: CompletionRequest,
): Promise<OpenAI.Chat.ChatCompletionMessage | undefined> {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: request.messages,
    temperature: request.temperature,
    ...chatCompletionCompatibilityParams(MODEL, request.maxOutputTokens),
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
  });
  return completion.choices[0]?.message;
}
