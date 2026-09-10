import { describe, expect, it } from "vitest";
import { classifyWebhookChange, isAiEligibleWebhookChange } from "@/lib/whatsapp/coexistenceWebhook";

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
