import { describe, expect, it } from "vitest";
import { detectIntent } from "./intent";

describe("detectIntent", () => {
  it("detecta agendamento", () => {
    expect(detectIntent("Oi, queria agendar um horário").type).toBe("schedule_appointment");
    expect(detectIntent("vocês têm vaga amanhã?").type).toBe("schedule_appointment");
  });

  it("detecta remarcação", () => {
    expect(detectIntent("preciso remarcar minha consulta").type).toBe("reschedule_appointment");
  });

  it("detecta cancelamento mesmo mencionando 'consulta'", () => {
    // "consulta" sozinho bateria com agendamento — cancelamento precisa vencer.
    expect(detectIntent("quero cancelar minha consulta de amanhã").type).toBe("cancel_appointment");
  });

  it("prioriza pedido de humano sobre outras leituras", () => {
    expect(detectIntent("quero falar com atendente sobre o agendamento").type).toBe("human_handoff");
  });

  it("detecta perguntas factuais", () => {
    expect(detectIntent("qual o preço do serviço?").type).toBe("ask_price");
    expect(detectIntent("qual horário vocês abrem?").type).toBe("ask_hours");
    expect(detectIntent("qual o endereço de vocês?").type).toBe("ask_address");
  });

  it("é tolerante a acentuação/maiúsculas", () => {
    expect(detectIntent("QUERO AGENDAR UM HORÁRIO").type).toBe("schedule_appointment");
    expect(detectIntent("qual o preco?").type).toBe("ask_price");
  });

  it("cai em general_question quando não reconhece nada", () => {
    const result = detectIntent("bom dia!");
    expect(result.type).toBe("general_question");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("nunca lança para texto vazio", () => {
    expect(() => detectIntent("")).not.toThrow();
    expect(detectIntent("").type).toBe("general_question");
  });
});
