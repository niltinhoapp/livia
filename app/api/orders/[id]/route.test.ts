// F1 da Lívia Alimentação V2 — ver e avançar o status de um pedido existente
// é gestão do comerciante e não pode depender de `bot.ordersEnabled`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveEstablishmentId = vi.fn();
const getOrder = vi.fn();
const transitionOrder = vi.fn();
const dispatchOrderStatusNotification = vi.fn();
class OrderOperationError extends Error { constructor(public code: string, message: string) { super(message); } }

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args),
}));
vi.mock("@/lib/orders", () => ({
  getOrder: (...args: unknown[]) => getOrder(...args),
  isOperationalOrder: (order: { status?: string }) => !["draft", "awaiting_confirmation"].includes(order.status ?? ""),
  transitionOrder: (...args: unknown[]) => transitionOrder(...args),
  OrderOperationError,
}));
vi.mock("@/lib/orderNotifications", () => ({
  dispatchOrderStatusNotification: (...args: unknown[]) => dispatchOrderStatusNotification(...args),
}));
vi.mock("@/lib/orderNotificationPolicy", () => ({
  orderNotificationEvent: (_fulfillment: unknown, status: string) => ["accepted", "ready_for_pickup", "out_for_delivery", "cancelled"].includes(status) ? status : null,
  orderNotificationId: (id: string, status: string, version: number) => `${id}__v${version}__${status}`,
}));

const { GET, PATCH } = await import("./route");
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  resolveEstablishmentId.mockResolvedValue("est-1");
  getOrder.mockResolvedValue({ id: "pedido-1", status: "preparing" });
  transitionOrder.mockResolvedValue({ id: "pedido-1", status: "out_for_delivery", fulfillment: "delivery", version: 8 });
  dispatchOrderStatusNotification.mockResolvedValue({ status: "sent" });
});

describe("/api/orders/[id]", () => {
  it("GET exige estabelecimento identificado", async () => {
    resolveEstablishmentId.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("https://livia.test/api/orders/pedido-1"), params("pedido-1"));

    expect(response.status).toBe(401);
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("GET devolve o pedido mesmo sem a IA de pedidos ligada", async () => {
    const response = await GET(new NextRequest("https://livia.test/api/orders/pedido-1"), params("pedido-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ order: { id: "pedido-1" } });
  });

  it("PATCH avança o status de um pedido em andamento sem depender do interruptor da IA", async () => {
    const request = new NextRequest("https://livia.test/api/orders/pedido-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "out_for_delivery", expectedVersion: 7, establishmentId: "est-injetado" }),
    });

    const response = await PATCH(request, params("pedido-1"));

    expect(response.status).toBe(200);
    expect(transitionOrder).toHaveBeenCalledWith("est-1", "pedido-1", "out_for_delivery", 7);
    expect(dispatchOrderStatusNotification).toHaveBeenCalledWith("est-1", "pedido-1__v8__out_for_delivery");
  });

  it("PATCH sem status continua recusando", async () => {
    const request = new NextRequest("https://livia.test/api/orders/pedido-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await PATCH(request, params("pedido-1"));

    expect(response.status).toBe(400);
    expect(transitionOrder).not.toHaveBeenCalled();
  });

  it("GET não expõe carrinho draft como pedido operacional", async () => {
    getOrder.mockResolvedValueOnce({ id: "draft-1", status: "draft" });
    const response = await GET(new NextRequest("https://livia.test/api/orders/draft-1"), params("draft-1"));
    expect(response.status).toBe(404);
  });

  it("PATCH exige a versão observada pela interface", async () => {
    const request = new NextRequest("https://livia.test/api/orders/pedido-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "accepted" }),
    });
    const response = await PATCH(request, params("pedido-1"));
    expect(response.status).toBe(400);
    expect(transitionOrder).not.toHaveBeenCalled();
  });

  it("retorna conflito seguro quando outra aba já atualizou o pedido", async () => {
    transitionOrder.mockRejectedValueOnce(new OrderOperationError("stale_version", "O pedido foi atualizado por outro operador."));
    const request = new NextRequest("https://livia.test/api/orders/pedido-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "accepted", expectedVersion: 3 }),
    });
    const response = await PATCH(request, params("pedido-1"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "stale_version" });
  });

  it("falha da notificação não desfaz nem transforma a mudança de status em erro", async () => {
    dispatchOrderStatusNotification.mockRejectedValueOnce(new Error("Meta indisponível"));
    const request = new NextRequest("https://livia.test/api/orders/pedido-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "out_for_delivery", expectedVersion: 7 }),
    });
    const response = await PATCH(request, params("pedido-1"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ order: { status: "out_for_delivery" }, notificationError: true });
  });

  it("não revela pedido de outro tenant quando o lookup escopado não encontra", async () => {
    getOrder.mockResolvedValueOnce(null);
    const response = await GET(new NextRequest("https://livia.test/api/orders/pedido-de-b"), params("pedido-de-b"));
    expect(response.status).toBe(404);
    expect(getOrder).toHaveBeenCalledWith("est-1", "pedido-de-b");
  });
});
