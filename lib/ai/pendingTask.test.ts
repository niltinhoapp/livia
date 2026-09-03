import { describe, expect, it } from "vitest";
import { derivePendingTask } from "./pendingTask";
import type { ConversationTask, Intent } from "@/types";

function intent(type: Intent["type"]): Intent {
  return { type, confidence: 0.7, entities: {} };
}

function task(state: ConversationTask["state"]): ConversationTask {
  return { type: "schedule_appointment", state, collectedData: {}, missingData: [], updatedAt: 1 };
}

describe("derivePendingTask", () => {
  it("nenhuma pendência quando a operação concluiu, mesmo com handoff/task presentes", () => {
    const result = derivePendingTask({
      intent: intent("schedule_appointment"),
      handoffActive: true,
      task: task("confirm"),
      operationCompleted: true,
    });
    expect(result).toBeNull();
  });

  it("handoff ativo vira awaiting_human, mesmo sem tarefa", () => {
    const result = derivePendingTask({
      intent: intent("general_question"),
      handoffActive: true,
      task: null,
      operationCompleted: false,
    });
    expect(result).toEqual({ type: "awaiting_human", waitingFor: "atendimento humano" });
  });

  it("handoff tem prioridade sobre uma tarefa em andamento", () => {
    const result = derivePendingTask({
      intent: intent("schedule_appointment"),
      handoffActive: true,
      task: task("offer_options"),
      operationCompleted: false,
    });
    expect(result?.type).toBe("awaiting_human");
  });

  it("tarefa em 'confirm' vira awaiting_customer_confirmation", () => {
    const result = derivePendingTask({
      intent: intent("schedule_appointment"),
      handoffActive: false,
      task: task("confirm"),
      operationCompleted: false,
    });
    expect(result).toEqual({ type: "awaiting_customer_confirmation", waitingFor: "cliente confirmar o horário" });
  });

  it("tarefa em outro estado vira appointment_started_incomplete", () => {
    const result = derivePendingTask({
      intent: intent("schedule_appointment"),
      handoffActive: false,
      task: task("collect_service"),
      operationCompleted: false,
    });
    expect(result?.type).toBe("appointment_started_incomplete");
  });

  it("reclamação sem handoff nem tarefa vira exception_needs_establishment", () => {
    const result = derivePendingTask({
      intent: intent("complaint"),
      handoffActive: false,
      task: null,
      operationCompleted: false,
    });
    expect(result?.type).toBe("exception_needs_establishment");
  });

  it("sem handoff, sem tarefa, sem reclamação: nenhuma pendência", () => {
    const result = derivePendingTask({
      intent: intent("ask_price"),
      handoffActive: false,
      task: null,
      operationCompleted: false,
    });
    expect(result).toBeNull();
  });
});
