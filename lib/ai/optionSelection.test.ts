import { describe, expect, it } from "vitest";
import {
  customerMessageBeforeLastBot,
  isTimeSlotList,
  parseEnumeratedOptions,
  parseOptionReference,
  resolvePendingOptionSelection,
} from "./optionSelection";

const XBURGER_LIST = "Temos duas opções de X-Burger:\n1. X-Burger — R$ 24,00\n2. X-Burger com bacon extra — R$ 29,00\nQual você prefere?";

describe("parseOptionReference", () => {
  it.each([
    ["1", 1], ["2", 2], ["1.", 1], ["1️⃣", 1], ["a 1", 1], ["o 2", 2], ["opção 2", 2], ["opcao 1", 1],
    ["número 3", 3], ["n° 2", 2], ["a primeira", 1], ["o segundo", 2], ["quero a 1", 1], ["pode ser o 2", 2],
    ["prefiro a segunda", 2], ["*1*", 1], ["1 por favor", 1],
  ])("'%s' → %i", (text, expected) => {
    expect(parseOptionReference(text)).toBe(expected);
  });

  it.each(["", "0", "10h", "às 10", "quero um x-burger", "1 coca e 1 x-burger", "sexta", "sim", "1 x-burger com bacon por favor"])(
    "'%s' não é escolha de opção",
    (text) => {
      expect(parseOptionReference(text)).toBeNull();
    },
  );
});

describe("parseEnumeratedOptions", () => {
  it("lê a lista numerada de produtos", () => {
    expect(parseEnumeratedOptions(XBURGER_LIST)).toEqual(["X-Burger — R$ 24,00", "X-Burger com bacon extra — R$ 29,00"]);
  });

  it("aceita '1)', '1 -', negrito e emoji numérico", () => {
    expect(parseEnumeratedOptions("1) Coca lata\n2) Coca 600ml")).toEqual(["Coca lata", "Coca 600ml"]);
    expect(parseEnumeratedOptions("*1.* Suco\n*2.* Água")).toEqual(["Suco", "Água"]);
    expect(parseEnumeratedOptions("1️⃣ Retirada\n2️⃣ Entrega")).toEqual(["Retirada", "Entrega"]);
    expect(parseEnumeratedOptions("1 - Pix\n2 - Cartão")).toEqual(["Pix", "Cartão"]);
  });

  it("número solto no texto ou item único não formam lista", () => {
    expect(parseEnumeratedOptions("O X-Burger custa R$ 24 e fica pronto em 20 min.")).toEqual([]);
    expect(parseEnumeratedOptions("1. X-Burger")).toEqual([]);
  });

  it("uma nova lista numerada substitui a anterior na mesma mensagem", () => {
    expect(parseEnumeratedOptions("1. A\n2. B\nE bebidas:\n1. Coca\n2. Suco\n3. Água")).toEqual(["Coca", "Suco", "Água"]);
  });
});

describe("isTimeSlotList", () => {
  it("reconhece horários e ignora preços e volumes", () => {
    expect(isTimeSlotList(["09:00", "10:00"])).toBe(true);
    expect(isTimeSlotList(["às 14h", "às 15h30"])).toBe(true);
    expect(isTimeSlotList(["X-Burger — R$ 24,00", "Coca lata 350ml"])).toBe(false);
  });
});

describe("resolvePendingOptionSelection", () => {
  it("'1' depois da lista de X-Burger escolhe o X-Burger", () => {
    const selection = resolvePendingOptionSelection([
      { role: "customer", text: "quero uma coca lata 350ml e x-burger" },
      { role: "bot", text: XBURGER_LIST },
      { role: "customer", text: "1" },
    ]);
    expect(selection).toEqual({ index: 1, item: "X-Burger — R$ 24,00", items: ["X-Burger — R$ 24,00", "X-Burger com bacon extra — R$ 29,00"] });
  });

  it("lista de horários fica com a agenda", () => {
    expect(resolvePendingOptionSelection([
      { role: "bot", text: "Horários:\n1. 09:00\n2. 10:00" },
      { role: "customer", text: "1" },
    ])).toBeNull();
  });

  it("índice fora da lista, lista antiga ou última fala do bot sem lista → null", () => {
    expect(resolvePendingOptionSelection([{ role: "bot", text: XBURGER_LIST }, { role: "customer", text: "3" }])).toBeNull();
    expect(resolvePendingOptionSelection([
      { role: "bot", text: XBURGER_LIST },
      { role: "customer", text: "hmm" },
      { role: "customer", text: "1" },
    ])).toBeNull();
    expect(resolvePendingOptionSelection([
      { role: "bot", text: XBURGER_LIST },
      { role: "customer", text: "quero" },
      { role: "bot", text: "Qual opção?" },
      { role: "customer", text: "1" },
    ])).toBeNull();
  });

  it("customerMessageBeforeLastBot devolve o pedido que gerou a lista", () => {
    expect(customerMessageBeforeLastBot([
      { role: "customer", text: "quero uma coca lata 350ml e x-burger" },
      { role: "bot", text: XBURGER_LIST },
      { role: "customer", text: "1" },
    ])).toBe("quero uma coca lata 350ml e x-burger");
  });
});
