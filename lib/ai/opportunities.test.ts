import { describe, expect, it } from "vitest";
import { opportunitiesFromPendingTasks, priceInquiryOpportunities, cancelledNoRebookingOpportunities } from "./opportunities";
import type { Appointment, Conversation, PendingTask } from "@/types";

function pendingTask(overrides: Partial<PendingTask> = {}): PendingTask {
  return {
    id: "conv1",
    establishmentId: "est1",
    conversationId: "conv1",
    contactPhone: "5511999990000",
    type: "awaiting_human",
    waitingFor: "atendimento humano",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    resolvedAt: null,
    dueAt: null,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv1",
    establishmentId: "est1",
    contactPhone: "5511999990000",
    contactName: "Maria",
    status: "bot",
    lastMessageAt: 1000,
    createdAt: 1,
    ...overrides,
  };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt1",
    establishmentId: "est1",
    contactPhone: "5511999990000",
    contactName: "Maria",
    serviceName: "Corte",
    startAt: 1000,
    durationMin: 30,
    status: "cancelled",
    source: "bot",
    note: null,
    createdAt: 1,
    confirmedAt: null,
    reminderSentAt: null,
    cancelledAt: 2000,
    ...overrides,
  };
}

describe("opportunitiesFromPendingTasks", () => {
  it("mapeia awaiting_human para handoff_waiting com nome resolvido", () => {
    const result = opportunitiesFromPendingTasks(
      [pendingTask({ type: "awaiting_human" })],
      new Map([["conv1", "Maria"]]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "handoff_waiting", contactName: "Maria", conversationId: "conv1" });
    expect(result[0]!.evidence).toContain("pendingTasks/conv1");
  });

  it("nome ausente no mapa vira null, nunca inventado", () => {
    const result = opportunitiesFromPendingTasks([pendingTask()], new Map());
    expect(result[0]!.contactName).toBeNull();
  });

  it("tipos sem mapeamento (ex.: awaiting_information) são ignorados", () => {
    const result = opportunitiesFromPendingTasks([pendingTask({ type: "awaiting_information" })], new Map());
    expect(result).toHaveLength(0);
  });

  it("cada tipo mapeado gera o OpportunityType certo", () => {
    const types = ["awaiting_human", "appointment_started_incomplete", "awaiting_customer_confirmation", "exception_needs_establishment"] as const;
    const result = opportunitiesFromPendingTasks(types.map((t) => pendingTask({ type: t, conversationId: t })), new Map());
    expect(result.map((o) => o.type)).toEqual([
      "handoff_waiting",
      "appointment_incomplete",
      "awaiting_confirmation",
      "complaint_unresolved",
    ]);
  });
});

describe("priceInquiryOpportunities", () => {
  it("ask_price + status bot + sem agendamento ativo: é oportunidade", () => {
    const result = priceInquiryOpportunities(
      [conversation({ lastIntent: "ask_price", status: "bot" })],
      () => false,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("price_inquiry_no_booking");
  });

  it("com agendamento ativo: NÃO é oportunidade (evita falso positivo)", () => {
    const result = priceInquiryOpportunities(
      [conversation({ lastIntent: "ask_price", status: "bot" })],
      () => true,
    );
    expect(result).toHaveLength(0);
  });

  it("status handoff/human: não conta (a Livia já não está sozinha nisso)", () => {
    const result = priceInquiryOpportunities(
      [conversation({ lastIntent: "ask_price", status: "handoff" }), conversation({ lastIntent: "ask_price", status: "human" })],
      () => false,
    );
    expect(result).toHaveLength(0);
  });

  it("outra intenção não gera oportunidade de preço", () => {
    const result = priceInquiryOpportunities([conversation({ lastIntent: "ask_hours", status: "bot" })], () => false);
    expect(result).toHaveLength(0);
  });
});

describe("cancelledNoRebookingOpportunities", () => {
  it("cancelado + sem agendamento ativo: é oportunidade, com evidence apontando pro agendamento", () => {
    const appt = appointment();
    const result = cancelledNoRebookingOpportunities([appt], () => false);
    expect(result).toHaveLength(1);
    expect(result[0]!.evidence).toContain(`appointments/${appt.id}`);
    expect(result[0]!.detectedAt).toBe(appt.cancelledAt);
  });

  it("cancelado mas já tem outro agendamento ativo: não é oportunidade", () => {
    const result = cancelledNoRebookingOpportunities([appointment()], () => true);
    expect(result).toHaveLength(0);
  });

  it("sem cancelledAt (documento antigo), usa createdAt como detectedAt em vez de quebrar", () => {
    const appt = appointment({ cancelledAt: null });
    const result = cancelledNoRebookingOpportunities([appt], () => false);
    expect(result[0]!.detectedAt).toBe(appt.createdAt);
  });
});
