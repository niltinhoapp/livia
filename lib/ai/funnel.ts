// Funil de agendamento — Passo 12/13 do README.md/Plano Mestre.
//
// Função pura: recebe contagens já calculadas (por quem consultou o
// Firestore) e devolve o funil pronto pra UI. Nunca estima receita, nunca
// calcula taxa quando o denominador é zero (devolve `null` — a UI decide
// como mostrar "sem dado" em vez de herdar um NaN ou um 0% enganoso).
//
// SEMÂNTICA (todas as etapas contam CONVERSAS, em subconjuntos encaixados):
//
//   atendimentos          conversas com atividade no período
//     ⊇ intencaoAgendar   as que demonstraram intenção de agendar
//         ⊇ concluidos    as que geraram ao menos um agendamento do bot
//           naoConcluidos = intencaoAgendar − concluidos
//
// Contar AGENDAMENTOS na última etapa (e conversas nas anteriores) era o bug
// que produzia 300% de conversão em Production: um mesmo contato agendou 3
// vezes no dia e o numerador passou o denominador. A taxa só é ≤ 100% porque
// "concluidos" é literalmente um subconjunto de "intencaoAgendar" — nunca
// por limitar/clampar o resultado.
export interface FunnelCounts {
  atendimentos: number;
  intencaoAgendar: number;
  agendamentosConcluidos: number;
}

export interface FunnelResult extends FunnelCounts {
  naoConcluidos: number;
  taxaConversao: number | null; // concluidos / intencaoAgendar, 0–1
}

export function computeFunnel(input: FunnelCounts): FunnelResult {
  const naoConcluidos = Math.max(0, input.intencaoAgendar - input.agendamentosConcluidos);
  const taxaConversao = input.intencaoAgendar > 0 ? input.agendamentosConcluidos / input.intencaoAgendar : null;
  return { ...input, naoConcluidos, taxaConversao };
}

// A conversa demonstrou intenção de agendar no período? Três evidências
// independentes, qualquer uma basta — nenhuma delas é palpite:
//
//   1. `lastScheduleIntentAt` dentro do período — carimbo durável gravado
//      quando a intenção foi detectada, imune à mensagem seguinte;
//   2. a ÚLTIMA mensagem ainda é de agendamento (conversa em andamento que
//      ainda não passou pela etapa de coleta de serviço/horário);
//   3. existe agendamento criado pelo BOT para este contato no período — um
//      agendamento criado é, por si só, prova de que houve intenção. Esta
//      terceira evidência é o que torna o funil correto mesmo para conversas
//      gravadas ANTES de `lastScheduleIntentAt` existir, e garante que a
//      etapa "intenção" nunca fique menor que a de "concluídos".
export interface ScheduleIntentEvidenceInput {
  lastIntent?: string;
  lastScheduleIntentAt?: number;
  contactPhoneKey: string; // telefone já normalizado por quem chama
  from: number;
  to: number;
  phonesWithBotAppointment: Set<string>;
}

export function hasScheduleIntentEvidence(input: ScheduleIntentEvidenceInput): boolean {
  const { lastIntent, lastScheduleIntentAt, contactPhoneKey, from, to, phonesWithBotAppointment } = input;

  if (typeof lastScheduleIntentAt === "number" && lastScheduleIntentAt >= from && lastScheduleIntentAt < to) {
    return true;
  }
  if (lastIntent === "schedule_appointment" || lastIntent === "reschedule_appointment") {
    return true;
  }
  return phonesWithBotAppointment.has(contactPhoneKey);
}

export interface FunnelConversation {
  contactPhoneKey: string; // telefone já normalizado por quem chama
  lastIntent?: string;
  lastScheduleIntentAt?: number;
}

export interface DailyFunnelInput {
  // Conversas com atividade no período (uma por contato — o id de conversa
  // JÁ é o telefone normalizado, então não há como duplicar aqui).
  conversations: FunnelConversation[];
  // Telefone (normalizado) de CADA agendamento criado pelo bot no período —
  // pode repetir quando o mesmo contato agendou mais de uma vez. A repetição
  // é colapsada de propósito: a etapa mede conversas que converteram, não
  // quantidade de agendamentos (esse número existe à parte, como
  // `agendamentosCriadosHoje`).
  botAppointmentPhoneKeys: string[];
  from: number;
  to: number;
}

// Monta o funil correlacionando agendamento → conversa que o originou (pelo
// telefone, que é a chave da conversa). Cada etapa é um subconjunto estrito
// da anterior, então a aritmética fecha sempre.
export function computeDailyFunnel(input: DailyFunnelInput): FunnelResult {
  const phonesWithBotAppointment = new Set(input.botAppointmentPhoneKeys);

  const comIntencao = input.conversations.filter((c) =>
    hasScheduleIntentEvidence({
      lastIntent: c.lastIntent,
      lastScheduleIntentAt: c.lastScheduleIntentAt,
      contactPhoneKey: c.contactPhoneKey,
      from: input.from,
      to: input.to,
      phonesWithBotAppointment,
    }),
  );

  const convertidas = comIntencao.filter((c) => phonesWithBotAppointment.has(c.contactPhoneKey));

  return computeFunnel({
    atendimentos: input.conversations.length,
    intencaoAgendar: comIntencao.length,
    agendamentosConcluidos: convertidas.length,
  });
}
