import { describe, expect, it } from "vitest";
import { startsAuditContext, taskAfterExplicitContextSwitch } from "./contextSwitch";

describe("startsAuditContext", () => {
  it("reconhece a mensagem real da Auditoria de Atendimento", () => {
    expect(
      startsAuditContext(
        "Oi Lívia! Acabei de fazer a Auditoria de Atendimento. Leads por dia: 8 Ticket médio: R$ 199 Tempo médio de resposta: Até 30 minutos Estimativa apresentada: R$ 2.388/mês",
      ),
    ).toBe(true);
  });

  it("reconhece a mensagem antiga da calculadora", () => {
    expect(
      startsAuditContext(
        "Acabei de rodar a Auditoria e o cálculo indicou que eu perco cerca de R$ 9.000 por mês devido ao meu tempo de resposta.",
      ),
    ).toBe(true);
  });

  it("reconhece calculadora mesmo sem valor financeiro", () => {
    expect(startsAuditContext("Fiz a calculadora de atendimento e queria entender o resultado.")).toBe(true);
  });

  it("não interrompe uma escolha normal de horário", () => {
    expect(startsAuditContext("Pode ser às 14:30")).toBe(false);
    expect(startsAuditContext("sexta de manhã")).toBe(false);
  });

  it("remove a tarefa antiga somente numa mudança explícita para auditoria", () => {
    const task = { type: "schedule_appointment", state: "offer_options" };
    expect(taskAfterExplicitContextSwitch("Acabei de fazer a Auditoria de Atendimento", task)).toBeNull();
    expect(taskAfterExplicitContextSwitch("às 14h", task)).toBe(task);
  });
});
