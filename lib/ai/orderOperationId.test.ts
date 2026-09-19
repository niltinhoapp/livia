import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment } from "@/types";

const addOrderItem = vi.fn(async () => ({
  id: "order-1",
  status: "draft",
  version: 1,
  items: [],
  fulfillment: null,
  deliveryAddress: null,
  payment: { method: null, status: "unpaid", changeForCents: null },
  subtotalCents: 0,
  deliveryFeeCents: 0,
  totalCents: 0,
}));

vi.mock("@/lib/orders", () => ({ addOrderItem }));
vi.mock("@/lib/firebase/admin", () => ({
  db: {},
  establishmentRef: vi.fn(),
  sub: vi.fn(),
}));

import { runTool, type ToolContext } from "./tools";

const ctx = {
  est: { id: "est-1", bot: { ordersEnabled: true } },
  kb: null,
  config: null,
  contactPhone: "5511999990000",
  contactName: "Cliente",
  offset: -180,
  customerProfile: null,
} as unknown as ToolContext;

beforeEach(() => vi.clearAllMocks());

describe("operationId interno de pedidos", () => {
  it("add_order_item encaminha __operationId interno ao serviço, sem expô-lo no schema", async () => {
    const tool = await runTool("add_order_item", {
      productId: "product-1",
      quantity: 1,
      __operationId: "toolcall.add-1",
    }, ctx);

    expect(tool.ok).toBe(true);
    expect(addOrderItem).toHaveBeenCalledTimes(1);
    expect(addOrderItem.mock.calls[0]?.at(-2)).toBe("toolcall.add-1");
    expect(addOrderItem.mock.calls[0]?.at(-1)).toBe(false);
  });
});
