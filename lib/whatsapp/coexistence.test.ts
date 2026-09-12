import { describe, expect, it } from "vitest";
import {
  classifyCoexistenceEvent,
  normalizeConnectionMode,
  shouldRegisterPhone,
  shouldTriggerAi,
} from "./coexistence";

describe("WhatsApp Coexistence", () => {
  it("mantém /register somente no Cloud API", () => {
    expect(shouldRegisterPhone("cloud_api")).toBe(true);
    expect(shouldRegisterPhone("coexistence")).toBe(false);
  });

  it("nunca dispara IA para eventos de sincronização ou echo", () => {
    expect(shouldTriggerAi("customer_message")).toBe(true);
    expect(shouldTriggerAi("message_echo")).toBe(false);
    expect(shouldTriggerAi("history")).toBe(false);
    expect(shouldTriggerAi("app_state_sync")).toBe(false);
    expect(shouldTriggerAi("status")).toBe(false);
    expect(shouldTriggerAi("unknown")).toBe(false);
  });

  it("classifica os eventos especiais do Coexistence", () => {
    expect(classifyCoexistenceEvent("smb_message_echoes")).toBe("message_echo");
    expect(classifyCoexistenceEvent("history")).toBe("history");
    expect(classifyCoexistenceEvent("smb_app_state_sync")).toBe("app_state_sync");
    expect(classifyCoexistenceEvent("messages")).toBe("unknown");
  });

  it("não ativa Coexistence com valor inválido", () => {
    expect(normalizeConnectionMode("coexistence")).toBe("coexistence");
    expect(normalizeConnectionMode("cloud_api")).toBe("cloud_api");
    expect(normalizeConnectionMode("anything-else")).toBe("cloud_api");
    expect(normalizeConnectionMode(undefined)).toBe("cloud_api");
  });
});
