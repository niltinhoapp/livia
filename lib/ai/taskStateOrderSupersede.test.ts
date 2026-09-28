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

  // O domínio pedido começa na CONSULTA ao cardápio ("quero uma coca e
  // x-burger" → search_menu), não só quando um item é gravado.
  it.each(["search_menu", "list_menu", "list_menu_category", "get_menu_product", "get_order_draft"] as const)(
    "AGENDA → PEDIDO: leitura do domínio pedido (%s) sem ferramenta de agenda encerra a tarefa de agenda",
    (name) => {
      const task = deriveTaskState({
        existingTask: agendaTask,
        intent: intent("general_question"),
        toolCalls: [{ name, args: { query: "x-burger" } }],
        booked: false,
      });
      expect(task).toBeNull();
    },
  );

  it("ferramenta fora dos domínios agenda/pedido (horário de funcionamento) não encerra a tarefa", () => {
    const task = deriveTaskState({
      existingTask: agendaTask,
      intent: intent("general_question"),
      toolCalls: [{ name: "get_business_hours", args: {} }],
      booked: false,
    });
    expect(task).toEqual(expect.objectContaining({ type: "schedule_appointment", state: "offer_options" }));
  });

  it("agenda concluída → apenas navegação no cardápio → a agenda não ressuscita", () => {
    // Turno 1: o agendamento foi concluído, a tarefa termina.
    const afterBooking = deriveTaskState({
      existingTask: { ...agendaTask, state: "confirm" },
      intent: intent("schedule_appointment"),
      toolCalls: [{ name: "create_appointment", args: { serviceName: "Corte", startAt: 1 } }],
      booked: true,
    });
    expect(afterBooking).toBeNull();
    // Turnos seguintes: só cardápio. Nenhuma tarefa de agenda reaparece.
    let task = afterBooking;
    for (const toolCalls of [
      [{ name: "list_menu" as const, args: {} }],
      [{ name: "list_menu_category" as const, args: { categoryId: "demo-cat-bebidas" } }],
      [{ name: "get_menu_product" as const, args: { productId: "demo-prod-coca" } }],
    ]) {
      task = deriveTaskState({ existingTask: task, intent: intent("general_question"), toolCalls, booked: false });
      expect(task).toBeNull();
    }
  });

  it("tarefa de agenda ainda gravada após o agendamento + só navegação no cardápio → encerrada", () => {
    const task = deriveTaskState({
      existingTask: { ...agendaTask, state: "confirm" },
      intent: intent("general_question"),
      toolCalls: [{ name: "list_menu", args: {} }],
      booked: false,
    });
    expect(task).toBeNull();
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
