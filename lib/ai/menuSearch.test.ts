import { describe, expect, it } from "vitest";
import { DEMO_CATALOG_PRODUCTS } from "@/lib/demo/catalog";
import { menuProductMatches, normalizeMenuText } from "./menuSearch";

const coca = {
  name: "Coca-Cola",
  description: null,
  variants: [
    { name: "Lata 350ml", active: true },
    { name: "Garrafa 600ml", active: true },
  ],
};

describe("normalizeMenuText", () => {
  it("normaliza acento, caixa, hífen e número colado na unidade", () => {
    expect(normalizeMenuText("Coca-Cola Lata 350ml")).toBe("coca cola lata 350 ml");
    expect(normalizeMenuText("Pão de Queijo")).toBe("pao de queijo");
  });
});

describe("menuProductMatches — Coca-Cola 350 ml (F5.4)", () => {
  it.each([
    "coca", "coca cola", "coca-cola", "coca lata", "coca 350", "coca 350ml", "coca cola 350ml", "coca-cola lata 350 ml",
    "Coca Cola", "COCA-COLA 350 ML", "cocas",
  ])("'%s' encontra a Coca-Cola", (query) => {
    expect(menuProductMatches(coca, query)).toBe(true);
  });

  it("a mesma busca funciona com o produto real do catálogo demo", () => {
    const product = DEMO_CATALOG_PRODUCTS.find((p) => p.id === "demo-prod-coca");
    expect(product).toBeDefined();
    expect(menuProductMatches(product!, "coca-cola lata 350 ml")).toBe(true);
  });

  it("variação inativa não conta para a busca", () => {
    const semLata = { ...coca, variants: [{ name: "Lata 350ml", active: false }, { name: "Garrafa 600ml", active: true }] };
    expect(menuProductMatches(semLata, "coca lata")).toBe(false);
    expect(menuProductMatches(semLata, "coca 600")).toBe(true);
  });

  it("não casa produto errado nem busca vazia", () => {
    expect(menuProductMatches(coca, "guaraná")).toBe(false);
    expect(menuProductMatches(coca, "coca 2l")).toBe(false);
    expect(menuProductMatches(coca, "   ")).toBe(false);
  });

  it("mantém o comportamento antigo de substring em nome/descrição", () => {
    expect(menuProductMatches({ name: "X-Burger", description: "pão, carne e queijo" }, "x-bur")).toBe(true);
    expect(menuProductMatches({ name: "X-Burger", description: "pão, carne e queijo" }, "carne e q")).toBe(true);
  });
});
