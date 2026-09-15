import type { Intent } from "@/types";

const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;

function normalize(text: string): string {
  return text
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A identidade automatizada só vale quando o canal fala de si. Não há regras
// baseadas somente em "bot", "automático" ou "assistente virtual": fechar
// uma conversa humana por esse motivo é pior que deixar passar outro bot.
const AUTOMATED_SELF_DECLARATION = [
  /\b(?:eu )?sou (?:(?:um|uma|o|a) )?(?:bot|chatbot|assistente virtual)\b/,
  /\b(?:este|esse|isto) (?:e|eh) (?:(?:um|uma|o|a) )?atendimento automatizado\b/,
  /\bvoce (?:esta|ta) falando com (?:nossa|nosso|uma|um|a|o) (?:assistente virtual|bot|chatbot)\b/,
];

export function declaresAutomatedRecipient(text: string): boolean {
  const normalized = normalize(text);
  return AUTOMATED_SELF_DECLARATION.some((pattern) => pattern.test(normalized));
}

const SOCIAL_WORDS = new Set([
  "ate", "mais", "logo", "tchau", "adeus", "obrigado", "obrigada", "obg", "valeu", "grato", "grata",
  "pelo", "atendimento", "bom", "boa", "otimo", "otima", "excelente", "dia", "tarde", "noite", "pra",
  "para", "voce", "voces", "vc", "tambem", "tenha", "um", "uma", "abraco", "beijo", "fique", "fica",
  "bem", "muito", "por", "tudo", "igualmente", "qualquer", "coisa", "eu", "chamo", "nao", "preciso",
  "de", "nada", "isso",
]);

const SOCIAL_SIGNAL = new Set([
  "tchau", "adeus", "ate", "obrigado", "obrigada", "obg", "valeu", "grato", "grata", "abraco", "beijo",
]);

export function isPureSocialFarewell(text: string): boolean {
  if (text.includes("?")) return false;
  const normalized = normalize(text);
  const words = normalized.split(" ").filter(Boolean);
  if (words.length === 0 || !words.every((word) => SOCIAL_WORDS.has(word))) return false;

  return (
    words.some((word) => SOCIAL_SIGNAL.has(word)) ||
    /\b(?:bom|boa|otimo|otima|excelente) dia\b/.test(normalized) ||
    normalized === "qualquer coisa eu chamo"
  );
}

export function isClearClosingReply(text: string): boolean {
  if (text.includes("?")) return false;
  const normalized = normalize(text);
  if (/\b(?:posso|precisa|quer|deseja|gostaria)\b.*\b(?:ajudar|algo|mais|informacao)\b/.test(normalized)) return false;

  return [
    /\bquando quiser\b.*\b(?:chamar|falar|estou|estamos)\b/,
    /\b(?:qualquer coisa|por aqui|fico a disposicao|estou a disposicao)\b/,
    /\bte esperamos\b/,
    /\b(?:ate mais|ate logo|tchau|adeus)\b/,
    /\b(?:conversa|atendimento) encerrad[oa]\b/,
  ].some((pattern) => pattern.test(normalized));
}

// Só pedidos/questões de cliente muito claros quebram o bloqueio contra outro
// bot. A intenção já classificada é sinal adicional, nunca motivo isolado.
export function isClearHumanDemand(text: string, intent: Intent): boolean {
  const normalized = normalize(text);
  if (!normalized || isPureSocialFarewell(text)) return false;

  if (
    /\b(?:quero|preciso|gostaria|queria)\b.*\b(?:marcar|agendar|horario|atendimento|falar|remarcar|cancelar|servico)\b/.test(normalized) ||
    /\b(?:quanto custa|qual (?:o )?(?:preco|valor)|voces atendem|atendem (?:no |aos? )?sabado|qual(?:es)? (?:os )?horarios?)\b/.test(normalized)
  ) {
    return true;
  }

  return (
    intent.type !== "general_question" &&
    /\b(?:quero|preciso|gostaria|queria|pode(?:m)?|consegue(?:m)?)\b/.test(normalized)
  );
}
