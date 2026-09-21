import type { FoodOrder, OrderNotificationEvent, OrderStatus } from "@/types";

export function orderNotificationEvent(
  fulfillment: FoodOrder["fulfillment"],
  status: OrderStatus,
): OrderNotificationEvent | null {
  if (status === "accepted" || status === "cancelled") return status;
  if (status === "ready_for_pickup" && fulfillment === "pickup") return status;
  if (status === "out_for_delivery" && fulfillment === "delivery") return status;
  return null;
}

export function orderNotificationId(orderId: string, status: OrderStatus, version: number): string {
  return `${orderId}__v${version}__${status}`;
}

export function orderNumber(orderId: string): string {
  return `#${orderId.slice(-6).toUpperCase()}`;
}

export function orderNotificationText(
  event: OrderNotificationEvent,
  orderId: string,
  establishmentName: string,
): string {
  const number = orderNumber(orderId);
  const prefix = establishmentName.trim() ? `${establishmentName.trim()}: ` : "";
  if (event === "accepted") return `${prefix}seu pedido ${number} foi aceito.`;
  if (event === "ready_for_pickup") return `${prefix}seu pedido ${number} está pronto para retirada.`;
  if (event === "out_for_delivery") return `${prefix}seu pedido ${number} saiu para entrega.`;
  return `${prefix}seu pedido ${number} foi cancelado.`;
}
