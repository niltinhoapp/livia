// Regras puras da máquina operacional F6. Este módulo pode ser consumido pelo
// painel sem importar o Admin SDK; o backend continua aplicando a mesma regra
// dentro da transação em lib/orders.ts.
import type { FoodOrder, OrderStatus } from "@/types";

export const ACTIVE_ORDER_STATUSES = [
  "confirmed",
  "accepted",
  "preparing",
  "ready_for_pickup",
  "out_for_delivery",
] as const satisfies readonly OrderStatus[];

export const CLOSED_ORDER_STATUSES = ["completed", "cancelled", "rejected"] as const satisfies readonly OrderStatus[];

const ACTIVE_DRAFT = new Set<OrderStatus>(["draft", "awaiting_confirmation"]);
const TERMINAL = new Set<OrderStatus>(CLOSED_ORDER_STATUSES);

export function isOperationalOrder(order: Pick<FoodOrder, "status">): boolean {
  return ACTIVE_ORDER_STATUSES.includes(order.status as typeof ACTIVE_ORDER_STATUSES[number]) ||
    CLOSED_ORDER_STATUSES.includes(order.status as typeof CLOSED_ORDER_STATUSES[number]);
}

export function allowedOrderTransitions(order: Pick<FoodOrder, "status" | "fulfillment">): OrderStatus[] {
  if (TERMINAL.has(order.status) || ACTIVE_DRAFT.has(order.status)) return [];
  if (order.status === "confirmed") return ["accepted", "cancelled"];
  if (order.status === "accepted") return ["preparing", "cancelled"];
  if (order.status === "preparing") return ["ready_for_pickup", "cancelled"];
  if (order.status === "ready_for_pickup") return order.fulfillment === "delivery" ? ["out_for_delivery", "cancelled"] : order.fulfillment === "pickup" ? ["completed", "cancelled"] : [];
  if (order.status === "out_for_delivery") return order.fulfillment === "delivery" ? ["completed", "cancelled"] : [];
  return [];
}

export function primaryOrderTransition(order: Pick<FoodOrder, "status" | "fulfillment">): { status: OrderStatus; label: string } | null {
  const next = allowedOrderTransitions(order).find((status) => status !== "cancelled");
  if (!next) return null;
  const labels: Partial<Record<OrderStatus, string>> = {
    accepted: "Aceitar pedido",
    preparing: "Iniciar preparo",
    ready_for_pickup: "Marcar como pronto",
    out_for_delivery: "Saiu para entrega",
    completed: "Concluir pedido",
  };
  return labels[next] ? { status: next, label: labels[next]! } : null;
}
