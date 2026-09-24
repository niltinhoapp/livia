import { readConfirmation } from "./confirmation";

export type ReminderIntent = "confirm" | "cancel" | null;

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.!,;?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NEGATED_CANCELLATION = [
  "nao precisa cancelar",
  "nao quero cancelar",
  "nao cancele",
  "pode deixar marcado",
  "vou comparecer",
];

const AMBIGUOUS_CANCELLATION = ["acho que", "talvez", "quem sabe", "pode ser que", "nao sei", "sei la", "em duvida"];

// Remarcar não é cancelar. Mesmo quando a pessoa não pode comparecer ao
// horário atual, a mudança de data/horário precisa seguir o fluxo normal da
// IA para escolher e reservar o novo slot com segurança.
const RESCHEDULE_INTENT = [
  "remarcar",
  "remarca",
  "mudar para",
  "muda para",
  "mudar o horario",
  "muda o horario",
  "outro horario",
  "tem outro",
];

function hasExplicitCancellation(text: string): boolean {
  return /\b(?:quero|pode) cancelar\b/.test(text) || /\b(?:cancelar|cancela|desmarcar|desmarca)\b/.test(text);
}

function hasInabilityToAttend(text: string): boolean {
  return /\bnao vou (?:conseguir|poder) ir\b/.test(text);
}

// Atalho determinístico para resposta curta a lembrete. Falso negativo é
// seguro (a conversa segue normalmente); falso positivo cancela um horário.
export function confirmCancelReminderIntent(text: string): ReminderIntent {
  const t = normalize(text);
  if (!t || t.length > 48) return null;

  if (NEGATED_CANCELLATION.some((phrase) => t.includes(phrase))) return null;
  if (AMBIGUOUS_CANCELLATION.some((phrase) => t.includes(phrase))) return null;
  if (RESCHEDULE_INTENT.some((phrase) => t.includes(phrase))) return null;

  const confirmation = readConfirmation(t);
  if (confirmation === "no" && !hasInabilityToAttend(t)) return null;

  if (hasExplicitCancellation(t) || hasInabilityToAttend(t)) return "cancel";
  return confirmation === "yes" ? "confirm" : null;
}
