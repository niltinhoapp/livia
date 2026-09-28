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

  // Revisão F5.4: a remoção de acentos não pode ser uma faixa ASCII que
  // engula dígitos ou letras (ex.: "'-?" cobre 0-9).
  it("'Coca-Cola' → coca + cola", () => {
    expect(normalizeMenuText("Coca-Cola").split(" ")).toEqual(["coca", "cola"]);
  });

  it("'350ml' → 350 + ml", () => {
    expect(normalizeMenuText("350ml").split(" ")).toEqual(["350", "ml"]);
  });

  it("'2L' → 2 + l", () => {
    expect(normalizeMenuText("2L").split(" ")).toEqual(["2", "l"]);
  });

  it("'Pizza 4 Queijos' mantém o 4", () => {
    expect(normalizeMenuText("Pizza 4 Queijos").split(" ")).toEqual(["pizza", "4", "queijos"]);
  });

  it("preserva todos os dígitos e letras; só pontuação vira espaço", () => {
    expect(normalizeMenuText("0123456789")).toBe("0123456789");
    expect(normalizeMenuText("ABCXYZ abcxyz")).toBe("abcxyz abcxyz");
    expect(normalizeMenuText("Água 1,5L (gelada)!")).toBe("agua 1 5 l gelada");
    expect(normalizeMenuText("X-Tudo / Açaí 500g?")).toBe("x tudo acai 500 g");
  });

  it("remove somente os diacríticos combinantes", () => {
    expect(normalizeMenuText("ÁÉÍÓÚ âêô ãõ ç ü")).toBe("aeiou aeo ao c u");
  });
});

describe("menuProductMatches — números no nome do produto", () => {
  it("'pizza 4 queijos' encontra a pizza pelo número e não casa com outro número", () => {
    const pizza = { name: "Pizza 4 Queijos", description: null, variants: [] };
    expect(menuProductMatches(pizza, "pizza 4 queijos")).toBe(true);
    expect(menuProductMatches(pizza, "4 queijos")).toBe(true);
    expect(menuProductMatches(pizza, "pizza 5 queijos")).toBe(false);
  });

  it("'guaraná 2l' encontra a variação de 2 litros", () => {
    const guarana = { name: "Guaraná", description: null, variants: [{ name: "2L", active: true }, { name: "Lata 350ml", active: true }] };
    expect(menuProductMatches(guarana, "guarana 2l")).toBe(true);
    expect(menuProductMatches(guarana, "guaraná 2 L")).toBe(true);
    expect(menuProductMatches(guarana, "guarana 3l")).toBe(false);
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

  it("número casa inteiro, nunca como prefixo de outro volume", () => {
    expect(menuProductMatches(coca, "coca 3")).toBe(false);
    expect(menuProductMatches(coca, "coca 35")).toBe(false);
    expect(menuProductMatches(coca, "coca 600")).toBe(true);
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
