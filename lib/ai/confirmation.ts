// Leitura segura de uma resposta de confirmação.
//
// Substitui a checagem por `includes` que existia no atalho de lembrete, onde
// "não é isso" virava CONFIRMAÇÃO (o texto contém "isso"). Para uma ação
// destrutiva como cancelar, esse erro cancela o horário de alguém que acabou
// de dizer "não".
//
// Regra de projeto: falso negativo é aceitável (pedimos de novo), falso
// positivo não é. Por isso a negação sempre vence, o hedge ("acho que sim")
// nunca conta como sim, e qualquer coisa fora do reconhecido é "unclear".

export type ConfirmationAnswer = "yes" | "no" | "unclear";

// Negação vence tudo — inclusive quando acompanhada de palavra positiva
// ("não, isso não", "não quero cancelar").
const NEGATIVE = [
  "nao",
  "nunca",
  "negativo",
  "deixa pra la",
  "deixa quieto",
  "esquece",
  "esquece isso",
  "de jeito nenhum",
  "melhor nao",
  "prefiro nao",
  "cancela nao",
];

// Hedge: tem cara de sim, mas não é inequívoco. Nunca executa a ação.
const HEDGE = ["acho que", "talvez", "quem sabe", "pode ser que", "nao sei", "sei la", "em duvida"];

// Afirmações inequívocas. "isso" sozinho NÃO entra: é ambíguo demais para
// autorizar um cancelamento ("isso mesmo" entra).
const POSITIVE = [
  "sim",
  "isso mesmo",
  "exatamente",
  "confirmo",
  "confirmado",
  "pode confirmar",
  "pode cancelar",
  "pode sim",
  "quero sim",
  "com certeza",
  "claro",
  "por favor cancela",
  "manda ver",
  "ok",
  "beleza",
  "👍",
];

function normalizar(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.!,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Casa a expressão como PALAVRA inteira, não como pedaço de outra — era o
// que fazia "isso" bater dentro de "não é isso".
function contemExpressao(texto: string, expressao: string): boolean {
  const escapada = expressao.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escapada}(\\s|$)`).test(texto);
}

export function readConfirmation(text: string): ConfirmationAnswer {
  const t = normalizar(text);
  if (!t) return "unclear";

  // Resposta longa quase nunca é um "sim" seco — trata como ambígua para não
  // autorizar ação destrutiva a partir de um texto que ninguém analisou.
  if (t.split(" ").length > 8) return "unclear";

  if (NEGATIVE.some((n) => contemExpressao(t, n))) return "no";
  if (HEDGE.some((h) => contemExpressao(t, h))) return "unclear";
  if (POSITIVE.some((p) => contemExpressao(t, p))) return "yes";
  return "unclear";
}
