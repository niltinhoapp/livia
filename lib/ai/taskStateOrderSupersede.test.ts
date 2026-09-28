// F5.4 — uma tarefa de agenda não sobrevive por inércia a um turno de PEDIDO.
import { describe, expect, it } from "vitest";
import { deriveTaskState } from "./taskState";
import type { ConversationTask, Intent } from "@/types";

function intent(type: Intent["type"]): Intent {
  return { type, confidence: 0.8, entities: {} };
}

const agendaTask: ConversationTask = {
  type: "schedule_appointment",
  state: "offer_options",
  collectedData: { date: "2026-10-02", serviceName: "Corte" },
  missingData: [],
  updatedAt: 0,
};

describe("deriveTaskState — AGENDA ↔ PEDIDO (F5.4)", () => {
  it("AGENDA → PEDIDO: escrita de pedido sem ferramenta de agenda encerra a tarefa de agenda", () => {
    const task = deriveTaskState({
      existingTask: agendaTask,
      intent: intent("general_question"),
      toolCalls: [{ name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1 } }],
      booked: false,
    });
    expect(task).toBeNull();
  });

  it("consulta ao cardápio (sem escrita de pedido) não encerra a tarefa de agenda", () => {
    const task = deriveTaskState({
      existingTask: agendaTask,
      intent: intent("general_question"),
      toolCalls: [{ name: "search_menu", args: { query: "x-burger" } }],
      booked: false,
    });
    expect(task).toEqual(expect.objectContaining({ type: "schedule_appointment", state: "offer_options" }));
  });

  it("turno misto (pedido + agenda) mantém a tarefa de agenda", () => {
    const task = deriveTaskState({
      existingTask: agendaTask,
      intent: intent("general_question"),
      toolCalls: [
        { name: "add_order_item", args: { productId: "demo-prod-coca", quantity: 1 } },
        { name: "find_available_appointments", args: { date: "2026-10-03" } },
      ],
      booked: false,
    });
    expect(task?.type).toBe("schedule_appointment");
    expect(task?.collectedData.date).toBe("2026-10-03");
  });

  it("PEDIDO → AGENDA: pedido de agendamento depois do pedido cria tarefa nova normalmente", () => {
    const task = deriveTaskState({
      existingTask: null,
      intent: intent("schedule_appointment"),
      toolCalls: [{ name: "find_available_appointments", args: { date: "2026-10-02" } }],
      booked: false,
    });
    expect(task).toEqual(expect.objectContaining({ type: "schedule_appointment", state: "offer_options" }));
  });

  it("nova intenção de agenda no mesmo turno de um pedido ainda vence (tarefa nova)", () => {
    const task = deriveTaskState({
      existingTask: agendaTask,
      intent: intent("cancel_appointment"),
      toolCalls: [{ name: "add_order_item", args: { productId: "demo-prod-xburger", quantity: 1 } }],
      booked: false,
    });
    expect(task?.type).toBe("cancel_appointment");
  });
});
