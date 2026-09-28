// Escolha por número de uma lista que a PRÓPRIA Lívia acabou de enviar.
//
// Função pura (sem I/O). Em Production (F5.4), depois de um agendamento de
// demonstração concluído, o cliente pediu lanche, a Lívia listou duas opções
// de X-Burger e o cliente respondeu "1" — e a resposta voltou para a agenda
// ("o horário das 10h está ocupado"). O "1" não carrega domínio sozinho: quem
// define o domínio é a lista a que ele responde. Este módulo liga a resposta
// curta à última lista enumerada do bot, para o cérebro ancorar o turno nela.
//
// Listas de HORÁRIOS continuam fora daqui de propósito: a escolha de horário
// já é resolvida pelo backend da agenda (resolveTimeSelection) e não muda.
import type { Message } from "@/types";

export interface PendingOptionSelection {
  index: number; // 1-based
  item: string;
  items: string[];
}

const ORDINALS: Record<string, number> = {
  primeira: 1, primeiro: 1,
  segunda: 2, segundo: 2,
  terceira: 3, terceiro: 3,
  quarta: 4, quarto: 4,
  quinta: 5, quinto: 5,
};

const KEYCAPS: Record<string, string> = {
  "1️⃣": "1", "2️⃣": "2", "3️⃣": "3", "4️⃣": "4", "5️⃣": "5",
  "6️⃣": "6", "7️⃣": "7", "8️⃣": "8", "9️⃣": "9",
};

function normalize(text: string): string {
  let out = text;
  for (const [emoji, digit] of Object.entries(KEYCAPS)) out = out.split(emoji).join(digit);
  return out
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Resposta que é SÓ a referência a uma opção: "1", "a 1", "opção 2",
// "quero a primeira", "pode ser o 2". Qualquer conteúdo além disso (um
// horário, um produto, uma data) não é escolha por número e segue o fluxo
// normal — a regra é estreita para não sequestrar mensagens reais.
export function parseOptionReference(text: string): number | null {
  const t = normalize(text).replace(/[.!)]+$/, "").trim();
  if (!t || t.length > 30) return null;
  const match = t.match(
    /^(?:(?:quero|queria|prefiro|escolho|fico com|vou de|vou querer|pode ser|manda|seria)\s+)?(?:(?:a|o)\s+)?(?:(?:opcao|numero|n[oº°]?)\s*)?(\d{1,2}|primeir[ao]|segund[ao]|terceir[ao]|quart[ao]|quint[ao])(?:\s+(?:opcao|por favor|pfv|pf))?$/,
  );
  if (!match) return null;
  const token = match[1]!;
  const index = /^\d+$/.test(token) ? Number(token) : ORDINALS[token];
  return index && index >= 1 ? index : null;
}

// Itens numerados de uma mensagem do bot: "1. X", "1) X", "1 - X", "*1.* X",
// "1️⃣ X". Precisa ser uma sequência 1..n contígua com n >= 2 — um número
// solto no texto ("R$ 24", "às 10") nunca vira lista.
export function parseEnumeratedOptions(botText: string): string[] {
  let text = botText;
  for (const [emoji, digit] of Object.entries(KEYCAPS)) text = text.split(emoji).join(`${digit}.`);
  const items: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[*_~]/g, "").trim();
    const m = line.match(/^(\d{1,2})\s*(?:\.\)|[.)\-–])\s*(.+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n !== items.length + 1) {
      if (n === 1) items.length = 0; // nova lista começa: fica a mais recente
      else continue;
    }
    items.push(m[2]!.trim());
  }
  return items.length >= 2 ? items : [];
}

// Um item de horário ("10:00", "às 14h", "9h30") marca a lista como de
// agenda. Preços ("R$ 24,00") e volumes ("350ml") não casam.
const TIME_IN_ITEM = /(?:^|[^\d,.])(?:[01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?)(?![\d])/i;

export function isTimeSlotList(items: string[]): boolean {
  return items.some((item) => TIME_IN_ITEM.test(item));
}

// Resolve a escolha pendente do turno atual: a última mensagem do cliente é
// uma referência de opção e a mensagem do bot imediatamente anterior trouxe
// uma lista enumerada (não de horários) com esse índice.
export function resolvePendingOptionSelection(history: Pick<Message, "role" | "text">[]): PendingOptionSelection | null {
  const last = history[history.length - 1];
  if (!last || last.role !== "customer") return null;
  const index = parseOptionReference(last.text);
  if (!index) return null;
  let previousBot: Pick<Message, "role" | "text"> | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === "customer") return null; // a lista não é a última fala do bot antes desta resposta
    if (message.role === "bot") { previousBot = message; break; }
  }
  if (!previousBot) return null;
  const items = parseEnumeratedOptions(previousBot.text);
  if (items.length < 2 || index > items.length || isTimeSlotList(items)) return null;
  return { index, item: items[index - 1]!, items };
}

// Mensagem do cliente que motivou a lista (a anterior à última fala do bot).
export function customerMessageBeforeLastBot(history: Pick<Message, "role" | "text">[]): string | null {
  let seenBot = false;
  for (let i = history.length - 2; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === "bot") seenBot = true;
    else if (message.role === "customer" && seenBot) return message.text;
  }
  return null;
}
