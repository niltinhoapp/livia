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

// Núcleo do parsing: "13", "13:00", "13h", "13h30", "14;30", "14.30",
// "13 30" e "13 e 30" — sem exigir que o horário seja o texto INTEIRO (ver
// parseTimeSelection).
//
// O "e" separando hora e minuto entrou depois de custar caro: "as 9 e 30"
// era lido como 09:00 (o grupo dos minutos não casava e virava opcional
// vazio), então a Livia dizia 09:30 e o backend reservava 09:00. O teste que
// existia só checava se a reserva acontecia — e 09:00 também era reservável,
// então o erro passou batido.
const TIME_CORE = /^(\d{1,2})(?:(?:\s*[:h;.,]\s*|\s+e\s+|\s+)(\d{2}))?\s*(?:h|hs|horas?)?\b/;

function toSelectedTime(hourStr: string, minuteStr: string | undefined): SelectedTime | null {
  const hour = Number(hourStr);
  const minute = minuteStr === undefined ? 0 : Number(minuteStr);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function parseTimeSelection(text: string): SelectedTime | null {
  let t = text.trim().toLowerCase();
  if (!t) return null;

  // Mensagem longa não é escolha de horário — é conversa.
  if (t.length > 30) return null;

  // Remove pontuação final e prefixos, possivelmente encadeados ("então as 13").
  t = t.replace(/[.!?]+$/, "").trim();
  // "as13", "às13" — sem espaço, como o cliente digitou em Production. O
  // lookahead exige dígito logo depois, então nenhuma palavra que comece com
  // "as" é mutilada.
  t = t.replace(/^([aà]s)(?=\d)/i, "");
  for (let i = 0; i < 3; i++) {
    const sem = t.replace(FILLERS, "").trim();
    if (sem === t) break;
    t = sem;
  }

  // Permite texto solto depois do horário ("marca as 9 pra mim", "9 por
  // favor") — antes disso qualquer coisa além do horário puro fazia esta
  // função devolver null e o pedido caía na IA, que recalculava o horário
  // por conta própria (fonte da divergência com a listagem real).
  const m = t.match(TIME_CORE);
  if (!m) return null;
  return toSelectedTime(m[1], m[2]);
}

// Acha um horário mencionado pela PRÓPRIA Livia numa mensagem anterior (ex.:
// "Vou agendar para você às 09:00. Confirma?"). Usada só quando o cliente
// responde com uma confirmação sem repetir o horário ("ss", "ok", "sim") —
// sem isto, o pedido caía na IA para "lembrar" e recalcular o horário
// proposto, e o recálculo divergia do horário real listado (ver
// resolveTimeSelection em lib/ai/brain.ts).
// \b não reconhece "à" acentuado como caractere de palavra (não é \w em JS) —
// por isso o texto é normalizado (NFD + remove diacríticos) ANTES do match,
// igual a normalizar() em lib/ai/confirmation.ts: "às" vira "as", e \b passa
// a funcionar normalmente antes dele.
//
// Casa as três formas em que a Livia menciona um horário: "13:00"/"13h30",
// "13h" e "às 13". A primeira versão disto exigia o "às" e por isso não via
// "o horário DAS 13:00 está disponível" — a frase exata que ela usou em
// Production para propor o horário.
const TIME_IN_TEXT = /(\d{1,2})[:h](\d{2})|(\d{1,2})\s*h\b|\bas\s+(\d{1,2})\b/g;

// Faixa ou aproximação não é escolha de horário: "entre 14 e 15h", "depois
// das 14", "umas 2 da tarde". Reservar 15:00 porque foi a única hora escrita
// em "entre 14 e 15h" é decidir pelo cliente — e "umas 2 da tarde" viraria
// 02:00 da madrugada. Nestes casos o sistema não decide: devolve null e a
// conversa segue, com a Livia oferecendo os horários reais.
const FAIXA_OU_APROXIMACAO =
  /\b(entre|ate|apos|depois d[aeo]s?|antes d[aeo]s?|a partir d[aeo]s?|por volta|umas?|ou)\b/;

// Só devolve algo se a mensagem mencionar UM horário. Numa mensagem com
// vários ("- 09:00 - 09:30 - 10:00…") não há escolha nenhuma: é uma lista de
// opções, e adivinhar qual delas um "sim" confirma reservaria um horário que
// ninguém escolheu. Nesse caso devolve null e o fluxo segue normal — falso
// negativo é barato, reserva errada não.
//
// Serve a dois usos, ambos com a mesma exigência de não-ambiguidade:
//   - ler o horário que a LIVIA propôs, quando o cliente só confirma ("ss");
//   - ler o horário do CLIENTE quando ele vem depois de outra coisa na
//     frase ("terça as 14"), caso em que parseTimeSelection não serve porque
//     exige o horário no começo do texto.
export function extractSingleTime(text: string): SelectedTime | null {
  const normalizado = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  if (FAIXA_OU_APROXIMACAO.test(normalizado)) return null;

  const encontrados = new Set<string>();
  let escolhido: SelectedTime | null = null;
  for (const m of normalizado.matchAll(TIME_IN_TEXT)) {
    const time = toSelectedTime(m[1] ?? m[3] ?? m[4]!, m[2]);
    if (!time) continue;
    encontrados.add(`${time.hour}:${time.minute}`);
    escolhido = time;
  }
  return encontrados.size === 1 ? escolhido : null;
}
