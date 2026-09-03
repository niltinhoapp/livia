import { describe, expect, it } from "vitest";
import { evaluateTrust } from "./trustPolicy";
import type { Intent, KnowledgeBase } from "@/types";

function intent(type: Intent["type"]): Intent {
  return { type, confidence: 0.7, entities: {} };
}

function kb(patch: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    establishmentId: "est1",
    about: "",
    address: null,
    hours: null,
    services: [],
    faqs: [],
    notes: null,
    paymentMethods: null,
    importantInfo: null,
    toneGuidelines: null,
    prohibitions: null,
    handoffTriggers: null,
    updatedAt: 0,
    ...patch,
  };
}

describe("evaluateTrust", () => {
  it("intenções não-factuais sempre têm fonte (nada a checar)", () => {
    expect(evaluateTrust(intent("schedule_appointment"), null).hasSource).toBe(true);
    expect(evaluateTrust(intent("general_question"), null).hasSource).toBe(true);
    expect(evaluateTrust(intent("human_handoff"), null).hasSource).toBe(true);
  });

  it("ask_price sem nenhum serviço com preço e sem FAQ: sem fonte", () => {
    const result = evaluateTrust(intent("ask_price"), kb({}));
    expect(result.hasSource).toBe(false);
    expect(result.directive).toMatch(/não invente/i);
  });

  it("ask_price com serviço tendo priceText: tem fonte", () => {
    const result = evaluateTrust(
      intent("ask_price"),
      kb({ services: [{ name: "Corte", priceText: "R$ 50", durationText: null, description: null }] }),
    );
    expect(result.hasSource).toBe(true);
  });

  it("ask_hours sem kb.hours: sem fonte", () => {
    expect(evaluateTrust(intent("ask_hours"), kb({})).hasSource).toBe(false);
    expect(evaluateTrust(intent("ask_hours"), null).hasSource).toBe(false);
  });

  it("ask_hours com kb.hours preenchido: tem fonte", () => {
    expect(evaluateTrust(intent("ask_hours"), kb({ hours: "Seg-Sex 9h-18h" })).hasSource).toBe(true);
  });

  it("ask_address sem kb.address: sem fonte", () => {
    expect(evaluateTrust(intent("ask_address"), kb({})).hasSource).toBe(false);
  });

  it("ask_address com kb.address preenchido: tem fonte", () => {
    expect(evaluateTrust(intent("ask_address"), kb({ address: "Rua X, 123" })).hasSource).toBe(true);
  });

  it("kb null nunca lança", () => {
    expect(() => evaluateTrust(intent("ask_price"), null)).not.toThrow();
  });
});
