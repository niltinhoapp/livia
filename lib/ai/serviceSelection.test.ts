import { describe, it, expect } from "vitest";
import { parseServiceSelection } from "@/lib/ai/serviceSelection";
import type { KnowledgeService } from "@/types";

const services: KnowledgeService[] = [
  { name: "Avaliação", priceText: null, durationText: null, description: null },
  { name: "Tratamento de Canal", priceText: null, durationText: null, description: null },
  { name: "Limpeza", priceText: null, durationText: null, description: null },
];

describe("parseServiceSelection", () => {
  it("reconhece o serviço citado, acento/caixa-insensível", () => {
    expect(parseServiceSelection("Remarca tbm pra amanha as 10 avaliação", services)).toBe("Avaliação");
    expect(parseServiceSelection("quero AVALIACAO", services)).toBe("Avaliação");
    expect(parseServiceSelection("preciso de tratamento de canal", services)).toBe("Tratamento de Canal");
  });

  it("retorna null quando nenhum serviço é citado", () => {
    expect(parseServiceSelection("As 17", services)).toBeNull();
    expect(parseServiceSelection("pode ser 17", services)).toBeNull();
    expect(parseServiceSelection("sim, confirmo", services)).toBeNull();
  });

  it("não adivinha quando dois serviços distintos são citados", () => {
    expect(parseServiceSelection("quero avaliação e limpeza", services)).toBeNull();
  });

  it("sem serviços cadastrados, retorna null", () => {
    expect(parseServiceSelection("avaliação", [])).toBeNull();
    expect(parseServiceSelection("avaliação", undefined)).toBeNull();
  });

  it("devolve o nome exatamente como cadastrado (canônico)", () => {
    expect(parseServiceSelection("faz limpeza?", services)).toBe("Limpeza");
  });
});
