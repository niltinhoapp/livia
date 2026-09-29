import { describe, expect, it } from "vitest";
import { AUDIT_CALCULATOR_MODEL, explainAuditEstimate } from "./auditCalculator";

// Réplica literal do cálculo de calculadora-livia/index.html:249-258, usada
// só para gerar os valores que a Calculadora real exibiria.
function calculadora(leads: number, ticketReais: number, minutos: 0 | 30 | 60 | 120 | 1440): number {
  const potencialMensal = (leads * 30) * 0.2 * ticketReais;
  const fatorPerda = minutos === 0 ? 1.0 : minutos === 30 ? 0.75 : minutos === 60 ? 0.5 : minutos === 120 ? 0.25 : 0.1;
  return Math.round(potencialMensal - potencialMensal * fatorPerda);
}

describe("explainAuditEstimate — modelo real da Calculadora", () => {
  it("78 leads/dia, ticket R$ 450, 'Até 30 minutos' = R$ 52.650 (25% de 468 vendas potenciais)", () => {
    expect(calculadora(78, 450, 30)).toBe(52_650);
    expect(explainAuditEstimate({ leadsPerDay: 78, averageTicketCents: 45_000, responseTimeText: "Até 30 minutos", estimatedOpportunityCentsPerMonth: 5_265_000 })).toMatchObject({
      monthlyLeads: 2_340,
      retainedShare: 0.75,
      lostShare: 0.25,
      estimateCents: 5_265_000,
    });
    const breakdown = explainAuditEstimate({ leadsPerDay: 78, averageTicketCents: 45_000, responseTimeText: "Até 30 minutos", estimatedOpportunityCentsPerMonth: 5_265_000 })!;
    expect(breakdown.potentialSales).toBeCloseTo(468);
    expect(breakdown.potentialRevenueCents).toBeCloseTo(21_060_000);
    expect(breakdown.lostSales).toBeCloseTo(117);
  });

  it.each([
    ["Até 5 minutos", 0 as const, 1],
    ["Até 30 minutos", 30 as const, 0.75],
    ["Cerca de 1 hora", 60 as const, 0.5],
    ["Mais de 2 horas", 120 as const, 0.25],
    ["No dia seguinte", 1440 as const, 0.1],
  ])("faixa '%s' fecha com o valor que a Calculadora exibe", (label, minutos, retained) => {
    const estimate = calculadora(37, 180, minutos);
    const breakdown = explainAuditEstimate({ leadsPerDay: 37, averageTicketCents: 18_000, responseTimeText: label, estimatedOpportunityCentsPerMonth: estimate * 100 });
    expect(breakdown?.retainedShare).toBe(retained);
    expect(breakdown?.lostShare).toBeCloseTo(1 - retained);
  });

  it("'Até 5 minutos' dá estimativa zero: nada perdido", () => {
    expect(calculadora(85, 1_560, 0)).toBe(0);
    expect(explainAuditEstimate({ leadsPerDay: 85, averageTicketCents: 156_000, responseTimeText: "Até 5 minutos", estimatedOpportunityCentsPerMonth: 0 })).toMatchObject({ lostShare: 0, lostSales: 0 });
  });

  it("ticket com centavos (exibido arredondado) continua fechando dentro da tolerância", () => {
    // ticket real R$ 99,60 → mensagem mostra "R$ 100"; estimativa calculada com 99,60.
    const estimate = Math.round(20 * 30 * 0.2 * 99.6 * 0.5);
    expect(explainAuditEstimate({ leadsPerDay: 20, averageTicketCents: 10_000, responseTimeText: "Cerca de 1 hora", estimatedOpportunityCentsPerMonth: estimate * 100 })).not.toBeNull();
  });

  it("números que não fecham ou faixa desconhecida não recebem decomposição", () => {
    expect(explainAuditEstimate({ leadsPerDay: 78, averageTicketCents: 45_000, responseTimeText: "Até 30 minutos", estimatedOpportunityCentsPerMonth: 9_999_900 })).toBeNull();
    expect(explainAuditEstimate({ leadsPerDay: 78, averageTicketCents: 45_000, responseTimeText: "Até 1 hora", estimatedOpportunityCentsPerMonth: 5_265_000 })).toBeNull();
    expect(explainAuditEstimate({ leadsPerDay: 78, averageTicketCents: 45_000, responseTimeText: "Até 30 minutos" })).toBeNull();
  });

  it("rótulo com caixa/acentuação diferente ainda é a mesma faixa", () => {
    expect(explainAuditEstimate({ leadsPerDay: 78, averageTicketCents: 45_000, responseTimeText: "ate 30 MINUTOS", estimatedOpportunityCentsPerMonth: 5_265_000 })?.responseTimeLabel).toBe("Até 30 minutos");
  });

  it("as faixas espelham exatamente as opções da Calculadora", () => {
    expect(AUDIT_CALCULATOR_MODEL.retainedByResponseTime.map((b) => b.label)).toEqual(["Até 5 minutos", "Até 30 minutos", "Cerca de 1 hora", "Mais de 2 horas", "No dia seguinte"]);
    expect(AUDIT_CALCULATOR_MODEL.idealConversionRate).toBe(0.2);
    expect(AUDIT_CALCULATOR_MODEL.daysPerMonth).toBe(30);
  });
});
