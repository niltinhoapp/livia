// Funil de agendamento — Passo 12/13 do README.md/Plano Mestre.
//
// Função pura: recebe contagens já calculadas (por quem consultou o
// Firestore) e devolve o funil pronto pra UI. Nunca estima receita, nunca
// calcula taxa quando o denominador é zero (devolve `null` — a UI decide
// como mostrar "sem dado" em vez de herdar um NaN ou um 0% enganoso).
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
