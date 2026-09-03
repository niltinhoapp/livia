import { describe, expect, it } from "vitest";
import { deriveTaskState } from "./taskState";
import type { ConversationTask, Intent } from "@/types";

function intent(type: Intent["type"]): Intent {
  return { type, confidence: 0.8, entities: {} };
}

describe("deriveTaskState", () => {
  it("inicia uma tarefa nova quando a intenção é de agendamento e não havia tarefa", () => {
    const task = deriveTaskState({
      existingTask: null,
      intent: intent("schedule_appointment"),
      toolCalls: [],
      booked: false,
    });
    expect(task).toEqual(
      expect.objectContaining({ type: "schedule_appointment", state: "collect_service" }),
    );
  });

  it("não inicia tarefa para perguntas factuais sem tarefa ativa", () => {
    const task = deriveTaskState({
      existingTask: null,
      intent: intent("ask_price"),
      toolCalls: [],
      booked: false,
    });
    expect(task).toBeNull();
  });

  it("avança para offer_options quando check_availability foi chamado", () => {
    const task = deriveTaskState({
      existingTask: null,
      intent: intent("schedule_appointment"),
      toolCalls: [{ name: "check_availability", args: { date: "2026-09-10" } }],
      booked: false,
    });
    expect(task?.state).toBe("offer_options");
    expect(task?.collectedData.date).toBe("2026-09-10");
  });

  it("continua a tarefa em andamento mesmo sem nova intenção reconhecida (não recomeça)", () => {
    const existing: ConversationTask = {
      type: "schedule_appointment",
      state: "offer_options",
      collectedData: { date: "2026-09-10" },
      missingData: [],
      updatedAt: 1,
    };
    // "sexta de manhã" não bate com nenhuma keyword — cai em general_question.
    const task = deriveTaskState({
      existingTask: existing,
      intent: intent("general_question"),
      toolCalls: [],
      booked: false,
    });
    expect(task?.type).toBe("schedule_appointment");
    expect(task?.state).toBe("offer_options"); // não retrocede nem reseta
  });

  it("limpa a tarefa quando o agendamento é concluído", () => {
    const existing: ConversationTask = {
      type: "schedule_appointment",
      state: "confirm",
      collectedData: {},
      missingData: [],
      updatedAt: 1,
    };
    const task = deriveTaskState({
      existingTask: existing,
      intent: intent("schedule_appointment"),
      toolCalls: [{ name: "create_appointment", args: { serviceName: "Corte" } }],
      booked: true,
    });
    expect(task).toBeNull();
  });

  it("substitui a tarefa quando chega uma intenção de tarefa diferente e incompatível", () => {
    const existing: ConversationTask = {
      type: "schedule_appointment",
      state: "offer_options",
      collectedData: {},
      missingData: [],
      updatedAt: 1,
    };
    const task = deriveTaskState({
      existingTask: existing,
      intent: intent("cancel_appointment"),
      toolCalls: [],
      booked: false,
    });
    expect(task?.type).toBe("cancel_appointment");
    expect(task?.state).toBe("collect_service");
  });

  it("não retrocede o estado quando create_appointment falha (booked=false)", () => {
    const existing: ConversationTask = {
      type: "schedule_appointment",
      state: "offer_options",
      collectedData: {},
      missingData: [],
      updatedAt: 1,
    };
    const task = deriveTaskState({
      existingTask: existing,
      intent: intent("schedule_appointment"),
      toolCalls: [{ name: "create_appointment", args: { serviceName: "Corte", startAt: 123 } }],
      booked: false,
    });
    expect(task?.state).toBe("confirm");
  });
});
