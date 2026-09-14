const GPT_56_TERRA = "gpt-5.6-terra";

// openai@4.104.0 ainda não inclui `none` no tipo de reasoning_effort,
// embora o endpoint já aceite e exija esse valor para function tools do Terra
// via Chat Completions. O Record mantém essa compatibilidade restrita a este
// ponto até uma atualização deliberada do SDK.
export function chatCompletionCompatibilityParams(
  model: string,
  maxCompletionTokens: number,
): Record<string, unknown> {
  return {
    max_completion_tokens: maxCompletionTokens,
    ...(model === GPT_56_TERRA ? { reasoning_effort: "none" } : {}),
  };
}
