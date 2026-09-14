import type { ConversationTask, Message } from "@/types";
import type { Intent } from "@/types";

const COMBINING_DIACRITICS = /[̀-ͯ]/g;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[!.,;:]+$/g, "")
    .trim();
}

const PASSIVE_TOKENS = new Set([
  "ok",
  "okay",
  "blz",
  "beleza",
  "certo",
  "entendi",
  "ta bom",
  "ta bem",
  "tudo bem",
  "show",
  "perfeito",
  "otimo",
  "legal",
  "top",
  "massa",
  "maravilha",
  "combinado",
  "fechado",
  "valeu",
  "vlw",
  "obg",
  "obrigado",
  "obrigada",
  "brigadao",
  "brigado",
  "brigada",
  "agradeço",
  "agradeco",
  "hum",
  "hmm",
  "ah",
  "ah ta",
  "ah sim",
  "aham",
  "uhum",
  "haha",
  "kkk",
  "kkkk",
  "kkkkk",
  "rs",
  "rsrs",
  "rsrsrs",
  "kk",
]);

const PASSIVE_EMOJI_ONLY = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s️]+$/u;

function isPassiveText(normalized: string): boolean {
  if (PASSIVE_TOKENS.has(normalized)) return true;
  if (PASSIVE_EMOJI_ONLY.test(normalized)) return true;
  if (/^k{2,}$/.test(normalized)) return true;
  if (/^(rs){1,}$/.test(normalized)) return true;
  if (/^(ha){2,}h?$/.test(normalized)) return true;
  return false;
}

function hasAdditionalContent(normalized: string): boolean {
  for (const token of PASSIVE_TOKENS) {
    if (normalized.startsWith(token + " ") || normalized.startsWith(token + ",")) {
      const rest = normalized.slice(token.length).replace(/^[\s,]+/, "");
      if (rest.length > 0) return true;
    }
  }
  return false;
}

function hasActiveTask(task: ConversationTask | null): boolean {
  return task !== null;
}

function lastBotAskedQuestion(history: Message[]): boolean {
  const last = [...history].reverse().find((m) => m.role === "bot");
  if (!last) return false;
  return last.text.trimEnd().endsWith("?");
}

export function isSilentAcknowledgement(
  customerText: string,
  intent: Intent,
  task: ConversationTask | null,
  history: Message[],
): boolean {
  if (intent.type !== "general_question") return false;

  const normalized = normalize(customerText);
  if (!normalized) return false;

  if (hasAdditionalContent(normalized)) return false;

  if (!isPassiveText(normalized)) return false;

  if (hasActiveTask(task)) return false;

  if (lastBotAskedQuestion(history)) return false;

  return true;
}
