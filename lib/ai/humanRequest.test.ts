// Matriz de handoff pedida no escopo da auditoria (Caso 4).
//
// A frase que originou tudo: a Livia ofereceu atendente, o cliente respondeu
// "n", e a conversa ficou muda para sempre.
import { describe, expect, it } from "vitest";
import { offeredHuman, readHumanIntent } from "@/lib/ai/humanRequest";

describe("pedido explícito de humano", () => {
  it.each([
    "quero falar com um atendente",
    "quero falar com alguém",
    "pode chamar uma pessoa?",
    "chama alguém pra mim",
    "me transfere",
    "quero atendimento humano",
    "quero falar com uma pessoa de verdade",
    "prefiro falar com um humano",
    "transfere para o responsável",
    "quero um atendente",
  ])("%s -> asks", (texto) => {
    expect(readHumanIntent(texto)).toBe("asks");
  });
});

describe("recusa de humano", () => {
  it.each([
    "não quero atendente",
    "nao quero falar com atendente",
    "não preciso de atendente",
    "pode continuar você",
    "continua você mesmo",
    "deixa você resolver",
    "não precisa chamar ninguém",
    "não precisa",
    "prefiro falar com você",
    "resolve você",
  ])("%s -> declines", (texto) => {
    expect(readHumanIntent(texto)).toBe("declines");
  });

  // O caso mais importante: a negação não pode ser lida como pedido só
  // porque contém as mesmas palavras.
  it("uma recusa NUNCA é lida como pedido", () => {
    for (const texto of ["não quero atendente", "não precisa chamar ninguém", "nao quero falar com humano"]) {
      expect(readHumanIntent(texto), texto).not.toBe("asks");
    }
  });
});

describe("mensagens que não decidem nada", () => {
  it.each([
    "n",
    "não",
    "ok",
    "obrigado",
    "quero agendar",
    "as 14",
    "atendimento", // fala de serviço, não pede humano
    "",
  ])("%s -> none", (texto) => {
    expect(readHumanIntent(texto)).toBe("none");
  });

  it('"atendimento" sozinho não transfere ninguém', () => {
    // Cliente real começou uma conversa exatamente assim, querendo agendar.
    expect(readHumanIntent("atendimento")).toBe("none");
  });
});

describe("reconhecer a oferta da Livia (dá sentido a um 'não' seco)", () => {
  it.each([
    "Posso transferir você para um atendente humano que poderá ajudar melhor. Você gostaria disso?",
    "Vou chamar uma pessoa da equipe pra te ajudar com isso, tudo bem?",
    "Quer que eu chame um atendente pra te ajudar?",
    "Você gostaria de atendimento humano?",
  ])("%s", (texto) => {
    expect(offeredHuman(texto)).toBe(true);
  });

  it.each([
    "Prontinho! Seu horário de Limpeza está reservado para 07/09 às 09:00.",
    "Qual horário você prefere?",
    "Os horários disponíveis são 09:00 e 09:30.",
  ])("não confunde resposta normal com oferta: %s", (texto) => {
    expect(offeredHuman(texto)).toBe(false);
  });
});
