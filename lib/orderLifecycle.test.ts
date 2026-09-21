import { describe, expect, it } from "vitest";
import { allowedOrderTransitions, isOperationalOrder, primaryOrderTransition } from "./orderLifecycle";

describe("máquina operacional compartilhada entre F6 e F11", () => {
  it("preserva os dois fluxos oficiais e nunca oferece transição de terminal", () => {
    expect(allowedOrderTransitions({ status: "ready_for_pickup", fulfillment: "delivery" })).toEqual(["out_for_delivery", "cancelled"]);
    expect(allowedOrderTransitions({ status: "ready_for_pickup", fulfillment: "pickup" })).toEqual(["completed", "cancelled"]);
    expect(allowedOrderTransitions({ status: "completed", fulfillment: "pickup" })).toEqual([]);
    expect(primaryOrderTransition({ status: "out_for_delivery", fulfillment: "delivery" })).toEqual({ status: "completed", label: "Concluir pedido" });
  });

  it("mantém draft fora da Central e reconhece encerrados para histórico", () => {
    expect(isOperationalOrder({ status: "draft" })).toBe(false);
    expect(isOperationalOrder({ status: "cancelled" })).toBe(true);
  });
});
