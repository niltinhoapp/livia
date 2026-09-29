import { describe, expect, it } from "vitest";
import { classifyWebhookChange, isAiEligibleWebhookChange, parseMessageEchoes } from "@/lib/whatsapp/coexistenceWebhook";

describe("Coexistence webhook classifier", () => {
  it("classifies smb_message_echoes as an echo and never AI", () => {
    const change = { field: "smb_message_echoes", value: { messages: [{ type: "text" }] } };
    expect(classifyWebhookChange(change)).toBe("message_echo");
    expect(isAiEligibleWebhookChange(change)).toBe(false);
  });

  it("classifies history as sync and never AI", () => {
    const change = { field: "history", value: { messages: [{ type: "text" }] } };
    expect(classifyWebhookChange(change)).toBe("history");
    expect(isAiEligibleWebhookChange(change)).toBe(false);
  });

  it("classifies smb_app_state_sync as state sync and never AI", () => {
    const change = { field: "smb_app_state_sync", value: {} };
    expect(classifyWebhookChange(change)).toBe("app_state_sync");
    expect(isAiEligibleWebhookChange(change)).toBe(false);
  });

  it("keeps ordinary messages eligible for the existing AI pipeline", () => {
    const change = { field: "messages", value: { messages: [{ type: "text" }] } };
    expect(classifyWebhookChange(change)).toBe("customer_message");
    expect(isAiEligibleWebhookChange(change)).toBe(true);
  });

  it("does not classify an empty change as an incoming message", () => {
    expect(classifyWebhookChange({ field: "messages", value: {} })).toBe("unknown");
  });
});

describe("parseMessageEchoes — respostas do atendente pelo app WhatsApp Business", () => {
  it("extrai eco de texto com destino e wamid", () => {
    expect(parseMessageEchoes({ message_echoes: [{ from: "551433334444", to: "5514988887777", id: "wamid.e1", type: "text", text: { body: " Oi! " } }] }))
      .toEqual([{ id: "wamid.e1", to: "5514988887777", text: "Oi!" }]);
  });

  it("mídia sem texto vira marcador; itens inválidos são ignorados", () => {
    expect(parseMessageEchoes({ message_echoes: [
      { to: "5514988887777", id: "wamid.e2", type: "image" },
      { to: "5514988887777", type: "text", text: { body: "sem id" } },
      null,
    ] })).toEqual([{ id: "wamid.e2", to: "5514988887777", text: "[Anexo enviado pelo atendente]" }]);
    expect(parseMessageEchoes(undefined)).toEqual([]);
  });

  it("eco continua fora do pipeline da IA", () => {
    expect(isAiEligibleWebhookChange({ field: "smb_message_echoes", value: { message_echoes: [{ id: "x", to: "y" }] } })).toBe(false);
  });
});
