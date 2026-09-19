// F1 da Lívia Alimentação V2 — a gestão de pedidos do painel não depende
// mais de `bot.ordersEnabled`. Esse interruptor controla o que a IA faz na
// conversa; desligá-lo no meio do expediente escondia do comerciante os
// pedidos já confirmados, em preparo ou saindo pra entrega.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveEstablishmentId = vi.fn();
const listOrders = vi.fn();
const ordersEnabledFor = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args),
}));
vi.mock("@/lib/orders", () => ({
  listOrders: (...args: unknown[]) => listOrders(...args),
}));
vi.mock("@/lib/ordersAccess", () => ({
  ordersEnabledFor: (...args: unknown[]) => ordersEnabledFor(...args),
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  resolveEstablishmentId.mockResolvedValue("est-1");
  listOrders.mockResolvedValue([{ id: "pedido-1", status: "preparing" }]);
  ordersEnabledFor.mockResolvedValue(true);
});

describe("GET /api/orders", () => {
  it("continua exigindo estabelecimento identificado", async () => {
    resolveEstablishmentId.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("https://livia.test/api/orders"));

    expect(response.status).toBe(401);
    expect(listOrders).not.toHaveBeenCalled();
  });

  it("lista pedidos normalmente com a IA de pedidos ligada", async () => {
    const response = await GET(new NextRequest("https://livia.test/api/orders"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ordersEnabled: true, orders: [{ id: "pedido-1" }] });
  });

  it("com a IA de pedidos DESLIGADA, ainda devolve os pedidos em andamento", async () => {
    ordersEnabledFor.mockResolvedValue(false);

    const response = await GET(new NextRequest("https://livia.test/api/orders"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orders).toHaveLength(1);
    expect(body.ordersEnabled).toBe(false);
    expect(listOrders).toHaveBeenCalledWith("est-1");
  });
});
