import { describe, expect, it } from "vitest";
import { textRequestsVoice } from "./voiceRequest";

describe("textRequestsVoice — pedido de áudio escrito em texto", () => {
  it.each([
    "manda um áudio",
    "manda audio",
    "me responde em áudio",
    "quero ouvir",
    "pode explicar por áudio",
    "prefiro áudio",
    "pode ser por áudio",
    "pode responder por áudio?",
    "manda em áudio pra mim",
    "explica por áudio, tô dirigindo",
    "sem problema, manda em áudio",
    "Prefiro em audio",
  ])("reconhece: %s", (text) => {
    expect(textRequestsVoice(text)).toBe(true);
  });

  it.each([
    "prefiro texto",
    "não precisa de áudio",
    "não quero áudio",
    "sem áudio, por favor",
    "mandei um áudio agora",
    "OK",
    "quero ver a demonstração",
    "o áudio não carregou",
  ])("não reconhece: %s", (text) => {
    expect(textRequestsVoice(text)).toBe(false);
  });
});
