// Interpretação determinística de "o cliente escolheu um horário".
//
// Existe porque, no fluxo real, o cliente responde só "13" depois de receber
// a lista de horários. Isso não bate com nenhuma regra de intenção (não tem
// palavra nenhuma), então o modelo ficava livre para inventar o desfecho —
// e inventou ("13:00 já foi ocupado") sem nunca chamar o backend.
//
// É proposital que esta função seja usada SOMENTE quando existe uma tarefa de
// agendamento aguardando escolha de horário (ver lib/ai/brain.ts). Fora desse
// contexto, "13" pode ser qualquer coisa e não deve virar reserva.

export interface SelectedTime {
  hour: number;
  minute: number;
}

// Prefixos comuns antes do horário: "às 14", "pode ser 15h", "quero o de 13".
const FILLERS =
  /^(pode ser|prefiro|quero( o de| o)?|vou (de|no|ficar com)|fica(mos)? (com|no)|o de|marca|marcar|agenda(r)?|as|às|ah|entao|então|acho que|talvez)\s+/i;

export function parseTimeSelection(text: string): SelectedTime | null {
  let t = text.trim().toLowerCase();
  if (!t) return null;

  // Mensagem longa não é escolha de horário — é conversa.
  if (t.length > 30) return null;

  // Remove pontuação final e prefixos, possivelmente encadeados ("então as 13").
  t = t.replace(/[.!?]+$/, "").trim();
  for (let i = 0; i < 3; i++) {
    const sem = t.replace(FILLERS, "").trim();
    if (sem === t) break;
    t = sem;
  }

  // "13", "13:00", "13h", "13h30", "14;30", "14.30", "13 30"
  const m = t.match(/^(\d{1,2})\s*(?:[:h;.,\s]\s*(\d{2}))?\s*(?:h|hs|horas?)?$/);
  if (!m) return null;

  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  return { hour, minute };
}
