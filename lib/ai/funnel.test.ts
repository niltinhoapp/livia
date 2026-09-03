import { describe, expect, it } from "vitest";
import { computeFunnel } from "./funnel";

describe("computeFunnel", () => {
  it("calcula não-concluídos e taxa de conversão normalmente", () => {
    const result = computeFunnel({ atendimentos: 10, intencaoAgendar: 4, agendamentosConcluidos: 3 });
    expect(result.naoConcluidos).toBe(1);
    expect(result.taxaConversao).toBeCloseTo(0.75);
  });

  it("taxa de conversão é null quando não há intenção de agendar (nunca divide por zero)", () => {
    const result = computeFunnel({ atendimentos: 10, intencaoAgendar: 0, agendamentosConcluidos: 0 });
    expect(result.taxaConversao).toBeNull();
    expect(result.naoConcluidos).toBe(0);
  });

  it("não-concluídos nunca fica negativo mesmo com dado inconsistente", () => {
    // concluídos > intençãoAgendar não deveria acontecer na prática, mas a
    // função não pode devolver um número negativo enganoso se acontecer.
    const result = computeFunnel({ atendimentos: 5, intencaoAgendar: 2, agendamentosConcluidos: 3 });
    expect(result.naoConcluidos).toBe(0);
  });

  it("preserva as contagens de entrada sem alterá-las", () => {
    const result = computeFunnel({ atendimentos: 7, intencaoAgendar: 5, agendamentosConcluidos: 2 });
    expect(result.atendimentos).toBe(7);
    expect(result.intencaoAgendar).toBe(5);
    expect(result.agendamentosConcluidos).toBe(2);
  });
});
