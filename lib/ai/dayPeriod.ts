// Período do dia e saudação temporal — fonte única e determinística.
//
// Motivo (OT-03G): a saudação ("bom dia"/"boa tarde"/"boa noite") era gerada
// livremente pelo modelo, sem nenhuma regra. Perto da meia-noite isso produziu
// em Production uma despedida com "Bom dia" enquanto o cliente dizia "Boa
// noite" — temporalmente incoerente. Este módulo centraliza os limites de
// período e o mapa de saudação para que o prompt (lib/ai/brain.ts) instrua o
// modelo com a saudação correta, e para que a regra seja testável sem IA.
//
// Timezone: a hora local vem do MESMO offset fixo do estabelecimento usado no
// resto do sistema (ScheduleConfig.utcOffsetMinutes; ver nowLocal em
// lib/ai/brain.ts e lib/ai/tools.ts). Nunca do relógio UTC do servidor
// diretamente. Não se assume America/Sao_Paulo aqui: o offset é um parâmetro.

export type DayPeriod = "madrugada" | "manha" | "tarde" | "noite";
export type TemporalGreeting = "bom dia" | "boa tarde" | "boa noite";

// Limites dos períodos, em hora local (24h). FONTE ÚNICA — não repetir estes
// números em nenhum outro lugar:
//   madrugada 00:00–05:59 · manhã 06:00–11:59 · tarde 12:00–17:59 · noite 18:00–23:59
const PERIOD_START = { manha: 6, tarde: 12, noite: 18 } as const;

const PERIOD_LABEL: Record<DayPeriod, string> = {
  madrugada: "madrugada",
  manha: "manhã",
  tarde: "tarde",
  noite: "noite",
};

export function dayPeriodFromHour(hour: number): DayPeriod {
  // Defensivo: normaliza qualquer inteiro para 0–23.
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  if (h < PERIOD_START.manha) return "madrugada";
  if (h < PERIOD_START.tarde) return "manha";
  if (h < PERIOD_START.noite) return "tarde";
  return "noite";
}

// Hora local a partir do instante UTC (ms) + offset fixo em minutos. Mesmo
// padrão de deslocamento de nowLocal (lib/ai/brain.ts): desloca e lê em UTC.
// Correto para offsets fixos (Brasil não tem horário de verão).
export function localHour(nowMs: number, offsetMin: number): number {
  return new Date(nowMs + offsetMin * 60000).getUTCHours();
}

export function dayPeriodFromLocal(nowMs: number, offsetMin: number): DayPeriod {
  return dayPeriodFromHour(localHour(nowMs, offsetMin));
}

// "bom dia" SÓ de manhã. Madrugada e noite cumprimentam "boa noite" — uso
// corrente no PT-BR e o que evita o "bom dia" absurdo no meio da noite/virada
// do dia (incidente OT-03G).
export function temporalGreeting(period: DayPeriod): TemporalGreeting {
  switch (period) {
    case "manha":
      return "bom dia";
    case "tarde":
      return "boa tarde";
    case "noite":
    case "madrugada":
      return "boa noite";
  }
}

// Saudação temporal explícita usada pelo interlocutor, se houver — para a
// Lívia não contradizê-la (FASE 3). Acento- e caixa-insensível; tolera
// "boanoite" grudado e espaços extras.
const GREETING_PATTERNS: { re: RegExp; greeting: TemporalGreeting }[] = [
  { re: /\bbom\s*dia\b/, greeting: "bom dia" },
  { re: /\bboa\s*tarde\b/, greeting: "boa tarde" },
  { re: /\bboa\s*noite\b/, greeting: "boa noite" },
];

export function detectUserTemporalGreeting(text: string): TemporalGreeting | null {
  const norm = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  for (const { re, greeting } of GREETING_PATTERNS) {
    if (re.test(norm)) return greeting;
  }
  return null;
}

// Linha de orientação injetada no prompt do sistema (lib/ai/brain.ts).
// Determinística e testável: dado o instante, o offset e (opcional) o texto do
// cliente, devolve a instrução de saudação. Não decide a resposta — orienta o
// modelo a ser coerente com o relógio e com a saudação da pessoa.
export function greetingGuidanceLine(
  nowMs: number,
  offsetMin: number,
  userText?: string | null,
): string {
  const period = dayPeriodFromLocal(nowMs, offsetMin);
  const greeting = temporalGreeting(period);
  const userGreeting = userText ? detectUserTemporalGreeting(userText) : null;

  const parts = [
    `Período do dia agora (horário local): ${PERIOD_LABEL[period]}.`,
    `Se usar uma saudação temporal, use "${greeting}", coerente com o período — nunca uma saudação de outro período (jamais "bom dia" à noite ou de madrugada).`,
  ];
  if (userGreeting) {
    parts.push(
      `A pessoa cumprimentou com "${userGreeting}"; acompanhe essa saudação e nunca a contradiga.`,
    );
  }
  parts.push(
    `Não force saudação em toda resposta. Em despedidas, uma saudação neutra ("até mais", "até logo") também é adequada e evita incoerência na virada do dia.`,
  );
  return parts.join(" ");
}
