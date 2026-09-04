import { describe, expect, it } from "vitest";
import { classifyConversation, applyOpportunityOverride } from "./inbox";

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

// Fix #2 da auditoria de 03/09: classifyConversationsForInbox (o caminho
// quente do poll de 15s) não calcula mais oportunidades — quem tem esse dado
// é o frontend, buscado separadamente. Este merge client-side reaplica a
// MESMA prioridade que classifyConversation já usa (oportunidade só vence
// "resolved").
describe("applyOpportunityOverride", () => {
  it("resolved + oportunidade -> opportunity", () => {
    expect(applyOpportunityOverride("resolved", true)).toBe("opportunity");
  });

  it("resolved sem oportunidade continua resolved", () => {
    expect(applyOpportunityOverride("resolved", false)).toBe("resolved");
  });

  it("nunca sobrepõe uma categoria mais urgente já vinda do backend", () => {
    for (const categoria of ["needs_human", "complaint", "customer_waiting", "appointment_incomplete"] as const) {
      expect(applyOpportunityOverride(categoria, true)).toBe(categoria);
    }
  });
});
