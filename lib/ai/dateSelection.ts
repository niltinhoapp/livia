// Interpretação determinística de "o cliente disse uma data".
//
// Irmã de lib/ai/timeSelection.ts, e existe pelo mesmo motivo: o HORÁRIO já
// era decidido por código (parseTimeSelection + localToEpoch), mas a DATA
// continuava sendo resolvida pelo modelo. Essa assimetria custou caro em
// Production (06/09/2026): a cliente pediu "terça-feira" e foi agendada na
// segunda, e outra conversa recebeu "muito próximo"/"fora do expediente"
// para horários de um dia que estava aberto — porque o instante enviado ao
// backend era de outro dia.
//
// A correção anterior (b169e0b) passou a injetar as datas resolvidas no
// prompt. Isso reduz o erro, mas não muda a natureza: continua sendo o
// modelo fazendo a correspondência, e não é verificável por teste. Aqui a
// data vira decisão do sistema, testável como qualquer outra regra.
//
// Todas as contas são feitas no "relógio de parede" do estabelecimento (a
// data local já resolvida por quem chama), nunca em UTC — o mesmo cuidado
// que localToEpoch tem para horário.

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

// Sem acento e em minúsculas, para casar "terça"/"terca"/"TERÇA".
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const WEEKDAYS_NORMALIZADOS = WEEKDAYS.map(normalizar);

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Meia-noite (em ms, escala UTC) do dia local informado — a base de todas as
// somas de dias aqui. `today` vem no formato YYYY-MM-DD já no fuso do
// estabelecimento, então nenhuma conversão de fuso acontece nesta função.
function meiaNoiteDe(today: string): number {
  const [y, m, d] = today.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/**
 * Resolve a data que o cliente citou, devolvendo YYYY-MM-DD, ou `null`
 * quando a mensagem não contém data nenhuma (o caso mais comum: "as 14",
 * "pode ser", "sim" — aí a data em discussão continua valendo).
 *
 * @param text  mensagem do cliente
 * @param today data de HOJE no fuso do estabelecimento (YYYY-MM-DD)
 */
export function parseDateSelection(text: string, today: string): string | null {
  const t = normalizar(text);
  if (!t.trim()) return null;

  const base = meiaNoiteDe(today);
  const DIA = 24 * 3600000;

  // 1. Referências relativas. "depois de amanhã" é testado antes de "amanhã"
  // porque a segunda é substring da primeira.
  if (/\bdepois de amanha\b/.test(t)) return isoDate(base + 2 * DIA);
  if (/\bamanha\b/.test(t)) return isoDate(base + DIA);
  if (/\bhoje\b/.test(t)) return today;

  // 2. Data explícita ISO (YYYY-MM-DD) — aceita porque é o formato que as
  // próprias ferramentas usam.
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // 3. Data explícita DD/MM ou DD/MM/AAAA. Sem ano, assume o ano corrente e
  // avança para o próximo ano se a data já passou (ninguém agenda no passado).
  const barra = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (barra) {
    const dia = Number(barra[1]);
    const mes = Number(barra[2]);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
      const anoBase = new Date(base).getUTCFullYear();
      let ano = barra[3] ? Number(barra[3]) : anoBase;
      if (ano < 100) ano += 2000;
      const alvo = Date.UTC(ano, mes - 1, dia);
      if (!barra[3] && alvo < base) return isoDate(Date.UTC(ano + 1, mes - 1, dia));
      return isoDate(alvo);
    }
  }

  // 4. Nome do dia da semana. A próxima ocorrência é sempre ESTRITAMENTE
  // futura (1 a 7 dias): num domingo, "segunda" é amanhã; numa segunda,
  // "segunda" é a semana que vem — nunca hoje, e nunca para trás.
  //
  // "que vem"/"próxima" NÃO somam mais uma semana de propósito: numa
  // segunda-feira, "terça que vem" e "terça" apontam para o mesmo dia no uso
  // corrente, e errar para frente faria o cliente perder uma semana.
  const diaSemana = WEEKDAYS_NORMALIZADOS.findIndex((nome) => new RegExp(`\\b${nome}(\\s*-?\\s*feira)?\\b`).test(t));
  if (diaSemana >= 0) {
    const hojeSemana = new Date(base).getUTCDay();
    const delta = ((diaSemana - hojeSemana + 7) % 7) || 7;
    return isoDate(base + delta * DIA);
  }

  // 5. "dia 8", "no dia 15". Se o número já passou neste mês, assume o mês
  // seguinte — mesma lógica de "nunca no passado" do item 3.
  const diaDoMes = t.match(/\bdia\s+(\d{1,2})\b/);
  if (diaDoMes) {
    const dia = Number(diaDoMes[1]);
    if (dia >= 1 && dia <= 31) {
      const hoje = new Date(base);
      const alvo = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), dia);
      if (alvo < base) return isoDate(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, dia));
      return isoDate(alvo);
    }
  }

  return null;
}
