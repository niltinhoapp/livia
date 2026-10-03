// Compatibilidade de parâmetros do Chat Completions por modelo.
//
// A Lívia chama o provider num único ponto (lib/ai/gateway.ts) e o modelo vem
// de LIVIA_MODEL. Este módulo é o que faz essa troca ser realmente só a troca
// da variável: traduz o modelo escolhido nos parâmetros que ELE aceita.
//
// O que a OpenAI impõe nos modelos de raciocínio e que importa aqui:
//
//   1. Function tools no /v1/chat/completions só são aceitas com
//      reasoning_effort "none". Sem isso o provider devolve 400 —
//      "Function tools with reasoning_effort are not supported for <modelo>
//      in /v1/chat/completions" — e devolve MESMO quando o parâmetro não é
//      enviado, porque o default desses modelos é "medium". Todo turno da
//      Lívia manda tools, então sem o "none" explícito é 400 em 100% das
//      mensagens.
//   2. temperature/top_p são rejeitados enquanto o raciocínio está ativo.
//      Na família gpt-5.6, com reasoning_effort "none" eles voltam a ser
//      aceitos — é o que mantém válido o temperature 0.4 do atendimento e
//      0.2 do resumo (e é o que roda em Production hoje com gpt-5.6-terra).
//      gpt-6-sol e gpt-6-luna são diferentes: mantêm o raciocínio sempre
//      ligado por dentro e rejeitam temperature em TODO nível de esforço,
//      inclusive "none" — "This model doesn't support the temperature
//      field. Remove temperature and try again." Para eles o parâmetro não
//      é enviado, e a Lívia perde o controle de temperatura (passa a valer
//      o default do provider). É um custo real de comportamento, não um
//      detalhe: está registrado em docs/TROCA-DE-MODELO.md.
//   3. Nem toda família aceita "none": gpt-6-astra e gpt-6.1-sol aceitam só
//      low..max e, por (1), não têm caminho para function tools no Chat
//      Completions. Usá-los exige a Responses API — é migração de endpoint,
//      não troca de modelo. REASONING_ONLY_ON_RESPONSES_API falha explícito
//      nesse caso, em vez de deixar o 400 do provider mandar toda conversa
//      para atendimento humano (lib/ai/llmContingency.ts trata 4xx como
//      "repetir não resolve" e aciona o handoff na primeira falha).
//
// Modelos sem raciocínio (gpt-4o, gpt-4o-mini) não aceitam reasoning_effort:
// para eles o parâmetro não é enviado. Modelo desconhecido recebe o mesmo
// tratamento — é o comportamento que a Lívia sempre teve, então um nome novo
// nunca piora o que já funciona.

// Famílias que exigem reasoning_effort "none" para aceitar function tools.
// Casa pelo prefixo da família, não pelo nome exato: trocar entre as tiers
// (sol/terra/luna) é só trocar LIVIA_MODEL, sem editar código.
const REASONING_NONE_REQUIRED = [
  // gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna
  /^gpt-5\.6-/,
  // gpt-6-sol | gpt-6-luna (aceitam "none"; gpt-6-astra não — ver abaixo)
  /^gpt-6-(sol|luna)\b/,
];

// Raciocínio que não desliga: sem "none", logo sem function tools no Chat
// Completions em nenhum nível de esforço.
const REASONING_ONLY_ON_RESPONSES_API = [/^gpt-6-astra\b/, /^gpt-6\.1-sol\b/];

// Famílias que rejeitam temperature/top_p mesmo com reasoning_effort "none".
// Enviar o parâmetro é 400 em toda mensagem — o mesmo efeito de parada total
// descrito em (1).
const TEMPERATURE_REJECTED = [/^gpt-6-(sol|luna)\b/];

export class UnsupportedModelError extends Error {
  constructor(public readonly model: string) {
    super(
      `O modelo "${model}" não aceita function tools no /v1/chat/completions ` +
        "(não suporta reasoning_effort \"none\"). Usar este modelo exige migrar " +
        "a chamada para a Responses API. Escolha um modelo da família gpt-5.6 " +
        "(sol/terra/luna) ou gpt-6-sol/gpt-6-luna em LIVIA_MODEL.",
    );
    this.name = "UnsupportedModelError";
  }
}

/** O modelo precisa de reasoning_effort "none" para aceitar function tools. */
export function requiresReasoningNone(model: string): boolean {
  return REASONING_NONE_REQUIRED.some((family) => family.test(model));
}

/** O modelo não tem caminho para function tools no Chat Completions. */
export function requiresResponsesApiForTools(model: string): boolean {
  return REASONING_ONLY_ON_RESPONSES_API.some((family) => family.test(model));
}

/** O modelo aceita `temperature`. Falso => o parâmetro não pode ser enviado. */
export function supportsTemperature(model: string): boolean {
  return !TEMPERATURE_REJECTED.some((family) => family.test(model));
}

// openai@4.104.0 ainda não inclui `none` no tipo de reasoning_effort, embora o
// endpoint já aceite e exija esse valor para function tools. O Record mantém
// essa compatibilidade restrita a este ponto até uma atualização deliberada
// do SDK.
//
// `temperature` entra por aqui, e não no gateway, porque é parâmetro que
// depende do modelo exatamente como os outros dois: quem decide o request
// por família é este módulo, num só lugar.
export function chatCompletionCompatibilityParams(
  model: string,
  maxCompletionTokens: number,
  temperature: number,
): Record<string, unknown> {
  if (requiresResponsesApiForTools(model)) throw new UnsupportedModelError(model);
  return {
    max_completion_tokens: maxCompletionTokens,
    ...(requiresReasoningNone(model) ? { reasoning_effort: "none" } : {}),
    ...(supportsTemperature(model) ? { temperature } : {}),
  };
}
