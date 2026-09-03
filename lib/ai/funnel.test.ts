import { describe, expect, it } from "vitest";
import { computeFunnel, computeDailyFunnel } from "./funnel";

const DAY_START = new Date("2026-09-02T03:00:00.000Z").getTime();
const DAY_END = DAY_START + 24 * 3600000;

describe("computeDailyFunnel — etapas correlacionadas (regressão do 300%)", () => {
  it("o mesmo contato agendando 3x no dia conta como UMA conversa convertida", () => {
    // Cenário exato de Production: 1 conversa ativa, 3 agendamentos do bot
    // criados por ela no mesmo dia. Antes, o numerador contava agendamentos
    // e o denominador conversas -> 300%.
    const funnel = computeDailyFunnel({
      conversations: [{ contactPhoneKey: "5514996455887", lastIntent: "general_question", lastScheduleIntentAt: DAY_START + 3600000 }],
      botAppointmentPhoneKeys: ["5514996455887", "5514996455887", "5514996455887"],
      from: DAY_START,
      to: DAY_END,
    });
    expect(funnel.atendimentos).toBe(1);
    expect(funnel.intencaoAgendar).toBe(1);
    expect(funnel.agendamentosConcluidos).toBe(1);
    expect(funnel.naoConcluidos).toBe(0);
    expect(funnel.taxaConversao).toBe(1); // 100%, nunca 300%
  });

  it("a taxa nunca passa de 100% em nenhuma combinação de entradas", () => {
    const phones = ["a", "b", "c"];
    for (const nConversas of [0, 1, 2, 3]) {
      for (const nAgendamentos of [0, 1, 5, 12]) {
        const funnel = computeDailyFunnel({
          conversations: phones.slice(0, nConversas).map((p) => ({ contactPhoneKey: p, lastIntent: "schedule_appointment" })),
          // vários agendamentos repetidos do MESMO contato, o pior caso
          botAppointmentPhoneKeys: Array.from({ length: nAgendamentos }, () => "a"),
          from: DAY_START,
          to: DAY_END,
        });
        expect(funnel.agendamentosConcluidos).toBeLessThanOrEqual(funnel.intencaoAgendar);
        expect(funnel.intencaoAgendar).toBeLessThanOrEqual(funnel.atendimentos);
        expect(funnel.naoConcluidos).toBeGreaterThanOrEqual(0);
        if (funnel.taxaConversao !== null) expect(funnel.taxaConversao).toBeLessThanOrEqual(1);
      }
    }
  });

  it("agendamento de contato sem conversa no período não infla a conversão", () => {
    const funnel = computeDailyFunnel({
      conversations: [{ contactPhoneKey: "aaa", lastIntent: "schedule_appointment" }],
      botAppointmentPhoneKeys: ["zzz"], // outro contato, sem conversa no período
      from: DAY_START,
      to: DAY_END,
    });
    expect(funnel.intencaoAgendar).toBe(1);
    expect(funnel.agendamentosConcluidos).toBe(0);
    expect(funnel.naoConcluidos).toBe(1);
  });

  it("duas conversas, só uma converteu: 50%", () => {
    const funnel = computeDailyFunnel({
      conversations: [
        { contactPhoneKey: "aaa", lastIntent: "schedule_appointment" },
        { contactPhoneKey: "bbb", lastIntent: "schedule_appointment" },
      ],
      botAppointmentPhoneKeys: ["aaa", "aaa"],
      from: DAY_START,
      to: DAY_END,
    });
    expect(funnel.intencaoAgendar).toBe(2);
    expect(funnel.agendamentosConcluidos).toBe(1);
    expect(funnel.taxaConversao).toBe(0.5);
  });

  it("conversa sem qualquer evidência de agendamento não entra na etapa 2", () => {
    const funnel = computeDailyFunnel({
      conversations: [{ contactPhoneKey: "aaa", lastIntent: "ask_hours" }],
      botAppointmentPhoneKeys: [],
      from: DAY_START,
      to: DAY_END,
    });
    expect(funnel.atendimentos).toBe(1);
    expect(funnel.intencaoAgendar).toBe(0);
    expect(funnel.taxaConversao).toBeNull();
  });
});

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
