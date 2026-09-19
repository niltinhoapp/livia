// F1 da Lívia Alimentação V2 — ver e avançar o status de um pedido existente
// é gestão do comerciante e não pode depender de `bot.ordersEnabled`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveEstablishmentId = vi.fn();
const getOrder = vi.fn();
const transitionOrder = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args),
}));
vi.mock("@/lib/orders", () => ({
  getOrder: (...args: unknown[]) => getOrder(...args),
  transitionOrder: (...args: unknown[]) => transitionOrder(...args),
}));

const { GET, PATCH } = await import("./route");
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  resolveEstablishmentId.mockResolvedValue("est-1");
  getOrder.mockResolvedValue({ id: "pedido-1", status: "preparing" });
  transitionOrder.mockResolvedValue({ id: "pedido-1", status: "out_for_delivery" });
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
      body: JSON.stringify({ status: "out_for_delivery" }),
    });

    const response = await PATCH(request, params("pedido-1"));

    expect(response.status).toBe(200);
    expect(transitionOrder).toHaveBeenCalledWith("est-1", "pedido-1", "out_for_delivery");
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
});
