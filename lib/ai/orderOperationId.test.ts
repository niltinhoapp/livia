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

    // Endereçamento por posição ABSOLUTA, não por `at(-1)`/`at(-2)`.
    //
    // A asserção original contava do fim da lista de argumentos. Quando
    // `addOrderDemoArg` passou a espalhar DOIS valores (automationFence e
    // demo), as duas últimas posições deixaram de ser operationId e
    // allowCreateAfterConfirmation — o teste passou a comparar `undefined`
    // e falhou, sem que nada em produção estivesse errado. A intenção
    // (provar que __operationId chega ao serviço) continua a mesma; só o
    // modo de localizar o argumento é que era frágil.
    //
    // Assinatura de lib/orders.ts::addOrderItem:
    //   0 establishmentId · 1 conversationId · 2 phone · 3 name
    //   4 productId · 5 variantId · 6 modifierOptionIds · 7 quantity
    //   8 notes · 9 operationId · 10 allowCreateAfterConfirmation
    //   11 automationFence · 12 demo
    const OPERATION_ID = 9;
    const ALLOW_CREATE_AFTER_CONFIRMATION = 10;
    const call = addOrderItem.mock.calls[0]! as unknown[];

    // Trava a aridade: se a assinatura mudar, isto falha explicitamente em
    // vez de deixar as asserções abaixo compararem o argumento errado.
    expect(call).toHaveLength(13);
    expect(call[OPERATION_ID]).toBe("toolcall.add-1");
    expect(call[ALLOW_CREATE_AFTER_CONFIRMATION]).toBe(false);
  });
});
