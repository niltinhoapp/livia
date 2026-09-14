import { describe, expect, it } from "vitest";
import { contentForAI } from "@/lib/ai/messageContent";
import type { Message } from "@/types";

const message = (overrides: Partial<Message>): Message => ({ id: "m1", role: "customer", text: "texto original", at: 1, ...overrides });

describe("contentForAI", () => {
  it("mantém mensagens legadas e textuais exatamente como eram", () => {
    expect(contentForAI(message({ text: "legado" }))).toBe("legado");
    expect(contentForAI(message({ kind: "text", text: "texto V2" }))).toBe("texto V2");
  });

  it("mantém mensagem de atendente textual", () => {
    expect(contentForAI(message({ role: "agent", kind: "text", text: "Vou continuar o atendimento." }))).toBe("Vou continuar o atendimento.");
  });

  it.each(["pending", "failed", "skipped"] as const)("não deixa áudio %s vazio", (status) => {
    expect(contentForAI(message({ kind: "audio", text: "[Áudio recebido]", transcription: { status } }))).toBe("[Áudio recebido — transcrição indisponível]");
  });

  it("usa transcrição concluída", () => {
    expect(contentForAI(message({ kind: "audio", transcription: { status: "completed", text: "preciso remarcar" } }))).toBe("preciso remarcar");
  });

  it.each(["image", "document", "video", "sticker", "location", "interactive", "unsupported"] as const)("usa marcador não vazio para %s", (kind) => {
    expect(contentForAI(message({ kind }))).not.toBe("");
  });
});
