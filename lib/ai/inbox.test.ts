import { describe, expect, it } from "vitest";
import { classifyConversation } from "./inbox";

describe("classifyConversation", () => {
  it("handoff ativo vence sobre qualquer outra coisa", () => {
    expect(
      classifyConversation({ status: "handoff", pendingTaskType: "appointment_started_incomplete", hasOpportunity: true }),
    ).toBe("needs_human");
  });

  it("pendingTask awaiting_human classifica como needs_human mesmo com status bot", () => {
    expect(classifyConversation({ status: "bot", pendingTaskType: "awaiting_human", hasOpportunity: false })).toBe(
      "needs_human",
    );
  });

  it("exception_needs_establishment classifica como complaint", () => {
    expect(
      classifyConversation({ status: "bot", pendingTaskType: "exception_needs_establishment", hasOpportunity: false }),
    ).toBe("complaint");
  });

  it("awaiting_customer_confirmation classifica como customer_waiting", () => {
    expect(
      classifyConversation({ status: "bot", pendingTaskType: "awaiting_customer_confirmation", hasOpportunity: false }),
    ).toBe("customer_waiting");
  });

  it("appointment_started_incomplete classifica como appointment_incomplete", () => {
    expect(
      classifyConversation({ status: "bot", pendingTaskType: "appointment_started_incomplete", hasOpportunity: false }),
    ).toBe("appointment_incomplete");
  });

  it("hasOpportunity sem pendingTask classifica como opportunity", () => {
    expect(classifyConversation({ status: "bot", hasOpportunity: true })).toBe("opportunity");
  });

  it("nada pendente e sem oportunidade: resolved", () => {
    expect(classifyConversation({ status: "bot", hasOpportunity: false })).toBe("resolved");
  });

  it("status human sem pendência classifica como resolved (a UI trata 'Em atendimento' à parte, pelo status bruto)", () => {
    expect(classifyConversation({ status: "human", hasOpportunity: false })).toBe("resolved");
  });
});
