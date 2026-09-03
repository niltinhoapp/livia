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
