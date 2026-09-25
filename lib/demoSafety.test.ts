import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { isLegacyBusinessInquiry } from "./demoSafety";

describe("legacyAliases configuráveis", () => {
  beforeEach(() => fakeDb.reset());

  it("não bloqueia pedido de comida sem correspondência com alias", async () => {
    fakeDb.col("establishments/demo/meta").set("demoSafety", { legacyAliases: ["Escola Antiga"] });
    await expect(isLegacyBusinessInquiry("demo", "quero ver o cardápio de lanches e bebidas")).resolves.toBe(false);
  });

  it("bloqueia correspondência real com alias configurado", async () => {
    fakeDb.col("establishments/demo/meta").set("demoSafety", { legacyAliases: ["Escola Antiga"] });
    await expect(isLegacyBusinessInquiry("demo", "Esse número é da escola antiga?")).resolves.toBe(true);
  });
});
