// Modelo da Calculadora/Auditoria de Atendimento — projeto externo
// `calculadora-livia/index.html` (linhas 234-258), que é a fonte de verdade:
//
//   potencialMensal = leadsPorDia × 30 × taxaConversaoIdeal(0,20) × ticket
//   fatorPerda      = parte do potencial que a Calculadora considera
//                     APROVEITADA por faixa de tempo de resposta
//   estimativa      = potencialMensal − potencialMensal × fatorPerda
//
// Só serve para EXPLICAR um resultado que a Calculadora já calculou. Os
// números recebidos são reconferidos contra este modelo: se não fecharem (a
// Calculadora mudou), nenhuma decomposição é afirmada.
export const AUDIT_CALCULATOR_MODEL = {
  daysPerMonth: 30,
  idealConversionRate: 0.2,
  retainedByResponseTime: [
    { label: "Até 5 minutos", retained: 1 },
    { label: "Até 30 minutos", retained: 0.75 },
    { label: "Cerca de 1 hora", retained: 0.5 },
    { label: "Mais de 2 horas", retained: 0.25 },
    { label: "No dia seguinte", retained: 0.1 },
  ],
} as const;

export interface AuditEstimateBreakdown {
  responseTimeLabel: string;
  leadsPerDay: number;
  averageTicketCents: number;
  monthlyLeads: number;
  potentialSales: number;
  potentialRevenueCents: number;
  retainedShare: number;
  lostShare: number;
  lostSales: number;
  estimateCents: number;
}

const normalizeLabel = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();

export function explainAuditEstimate(audit: {
  leadsPerDay?: number;
  averageTicketCents?: number;
  responseTimeText?: string;
  estimatedOpportunityCentsPerMonth?: number;
}): AuditEstimateBreakdown | null {
  const { leadsPerDay, averageTicketCents, responseTimeText, estimatedOpportunityCentsPerMonth: estimateCents } = audit;
  if (!leadsPerDay || !averageTicketCents || !responseTimeText || estimateCents === undefined) return null;
  const band = AUDIT_CALCULATOR_MODEL.retainedByResponseTime.find((b) => normalizeLabel(b.label) === normalizeLabel(responseTimeText));
  if (!band) return null;

  const monthlyLeads = leadsPerDay * AUDIT_CALCULATOR_MODEL.daysPerMonth;
  const potentialSales = monthlyLeads * AUDIT_CALCULATOR_MODEL.idealConversionRate;
  const potentialRevenueCents = potentialSales * averageTicketCents;
  const lostShare = 1 - band.retained;
  const recomputed = potentialRevenueCents * lostShare;
  // A Calculadora exibe ticket e estimativa arredondados para reais inteiros:
  // meio real de erro no ticket se multiplica pelas vendas perdidas.
  const tolerance = potentialSales * lostShare * 50 + 51;
  if (Math.abs(recomputed - estimateCents) > tolerance) return null;

  return {
    responseTimeLabel: band.label,
    leadsPerDay,
    averageTicketCents,
    monthlyLeads,
    potentialSales,
    potentialRevenueCents,
    retainedShare: band.retained,
    lostShare,
    lostSales: potentialSales * lostShare,
    estimateCents,
  };
}
