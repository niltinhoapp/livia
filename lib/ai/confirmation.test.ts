// Matcher de confirmação — risco 6, demonstrado antes da correção:
//
//   "não é isso"     -> confirm   (o texto contém "isso")
//   "nao e isso"     -> confirm
//   "não, isso não"  -> confirm
//
// Num fluxo de cancelamento isso cancela o horário de quem acabou de dizer
// "não". Regra: falso negativo é aceitável, falso positivo não.
import { describe, expect, it } from "vitest";
import { readConfirmation } from "./confirmation";

describe("negativos — nunca autorizam a ação", () => {
  it.each(["não", "nao", "não é isso", "nao e isso", "não, isso não", "deixa pra lá", "não quero cancelar"])(
    "'%s' -> no",
    (texto) => {
      expect(readConfirmation(texto)).toBe("no");
    },
  );

  it("negação vence mesmo acompanhada de palavra positiva", () => {
    expect(readConfirmation("não, pode cancelar não")).toBe("no");
    expect(readConfirmation("sim... não, deixa pra lá")).toBe("no");
  });
});

describe("positivos inequívocos", () => {
  it.each(["sim", "sim, pode cancelar", "pode cancelar", "confirmo", "isso mesmo"])("'%s' -> yes", (texto) => {
    expect(readConfirmation(texto)).toBe("yes");
  });
});

describe("ambíguos — preferimos perguntar de novo a cancelar por engano", () => {
  it.each(["acho que sim", "talvez", "isso"])("'%s' -> unclear", (texto) => {
    expect(readConfirmation(texto)).toBe("unclear");
  });

  it("vazio e texto sem relação também são ambíguos", () => {
    expect(readConfirmation("")).toBe("unclear");
    expect(readConfirmation("   ")).toBe("unclear");
    expect(readConfirmation("bom dia")).toBe("unclear");
  });

  it("resposta longa não é lida como sim seco", () => {
    expect(readConfirmation("sim eu gostaria de saber se vocês atendem convênio também por favor")).toBe("unclear");
  });
});

describe("casamento por palavra inteira (a origem do bug)", () => {
  it("'isso' dentro de outra frase não vira confirmação", () => {
    expect(readConfirmation("não é isso")).not.toBe("yes");
    expect(readConfirmation("isso não")).not.toBe("yes");
  });

  it("tolera acento, maiúscula e pontuação", () => {
    expect(readConfirmation("SIM!")).toBe("yes");
    expect(readConfirmation("Não.")).toBe("no");
    expect(readConfirmation("Isso mesmo!")).toBe("yes");
  });
});
