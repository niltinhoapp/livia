import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
import { stableToolOperationId } from "@/lib/ai/operationId";

describe("identidade estável de mutações comerciais", () => {
  it("não depende da ordem das tool calls no replay", () => {
    const firstRun = [
      ["add_order_item", { productId: "burger", quantity: 2 }],
      ["set_order_payment", { method: "pix" }],
    ] as const;
    const replayReordered = [...firstRun].reverse();

    const idsA = new Set(firstRun.map(([name, args]) => stableToolOperationId("wamid.1", name, args)));
    const idsB = new Set(replayReordered.map(([name, args]) => stableToolOperationId("wamid.1", name, args)));
    expect(idsB).toEqual(idsA);
  });

  it("canonicaliza a ordem das propriedades e separa ocorrências intencionais", () => {
    const a = stableToolOperationId("wamid.1", "add_order_item", { productId: "burger", quantity: 2 }, 0);
    const b = stableToolOperationId("wamid.1", "add_order_item", { quantity: 2, productId: "burger" }, 0);
    const secondOccurrence = stableToolOperationId("wamid.1", "add_order_item", { productId: "burger", quantity: 2 }, 1);
    expect(a).toBe(b);
    expect(secondOccurrence).not.toBe(a);
  });
});
