import { describe, expect, it } from "vitest";
import type { ConversationContext } from "@/types";
import { historyForConversationContext, transitionConversationContext } from "./conversationPolicy";
import {
  asksCommercialProductPrice,
  commercialDemoGuidance,
  enrichCommercialContext,
  explicitlyQualifiesAudit,
  extractAuditData,
  inferCommercialSegment,
  normalizeAuditData,
} from "./commercialContext";
import { commercialProductFacts, formatCommercialPrice, LIVIA_COMMERCIAL_PRODUCT } from "@/lib/commercial/product";

const audit = (over: Partial<ConversationContext> = {}): ConversationContext => ({
  purpose: "audit",
  source: "audit_calculator",
  enteredAt: 100,
  updatedAt: 100,
  ...over,
});

describe("fonte comercial", () => {
  it("centraliza preço, ciclo, trial e capacidades reais", () => {
    expect(LIVIA_COMMERCIAL_PRODUCT.monthlyPriceCents).toBe(12_900);
    expect(LIVIA_COMMERCIAL_PRODUCT.trialDays).toBe(7);
    expect(LIVIA_COMMERCIAL_PRODUCT.billingCycle).toBe("monthly");
    expect(formatCommercialPrice()).toMatch(/R\$\s*129/);
    expect(commercialProductFacts().join(" ")).toContain("backend");
  });

  it("distingue preço comercial de preço de serviço", () => {
    expect(asksCommercialProductPrice("Quanto custa?")).toBe(true);
    expect(asksCommercialProductPrice("Qual o preço da Lívia?")).toBe(true);
    expect(asksCommercialProductPrice("Quanto custa o corte?")).toBe(false);
  });
});

describe("dados estruturados da Auditoria", () => {
  it("extrai somente campos rotulados da Calculadora", () => {
    expect(extractAuditData(
      "Leads por dia: 20 Ticket médio: R$150 Tempo médio de resposta: 2 horas Estimativa: R$12.000/mês",
      100,
    )).toEqual({
      leadsPerDay: 20,
      averageTicketCents: 15_000,
      responseTimeText: "2 horas",
      estimatedOpportunityCentsPerMonth: 1_200_000,
      capturedAt: 100,
    });
    expect(extractAuditData("acho que perco 12 mil por mês", 100)).toBeNull();
  });

  it("aceita entrada estruturada validada e rejeita valores absurdos", () => {
    expect(normalizeAuditData({ leadsPerDay: 8, averageTicketCents: 19_900 }, 10)).toMatchObject({ leadsPerDay: 8, averageTicketCents: 19_900 });
    expect(normalizeAuditData({ leadsPerDay: -1, averageTicketCents: Number.NaN }, 10)).toBeNull();
  });

  it("persiste dados sem apagar campos recebidos em turnos anteriores", () => {
    const first = enrichCommercialContext({
      context: audit(),
      text: "Leads por dia: 20 Ticket médio: R$150 Tempo médio: 2 horas Estimativa: R$12.000/mês",
      now: 100,
      allowAuditQualification: false,
    });
    const second = enrichCommercialContext({ context: first.context, text: "Tenho um restaurante", now: 200, allowAuditQualification: true });
    const third = enrichCommercialContext({ context: second.context, text: "Como você poderia me ajudar?", now: 300, allowAuditQualification: true });

    expect(third.context.purpose).toBe("audit");
    expect(third.context.audit).toMatchObject({ leadsPerDay: 20, averageTicketCents: 15_000, responseTimeText: "2 horas", estimatedOpportunityCentsPerMonth: 1_200_000 });
    expect(third.context.commercial?.segment).toBe("restaurant");
  });
});

describe("segmentação comercial", () => {
  it.each([
    ["Tenho uma clínica", "clinic"],
    ["Meu negócio é um salão", "salon"],
    ["Tenho um restaurante delivery", "restaurant"],
    ["Balas e doces", "restaurant"],
    ["É um pet shop com banho e tosa", "pet"],
    ["Tenho uma ótica", "optical"],
    ["Presto serviços de assistência técnica", "services"],
  ] as const)("%s -> %s", (text, expected) => {
    expect(inferCommercialSegment(text)).toBe(expected);
  });

  it("assuntos gerais não são gatilho comercial", () => {
    expect(inferCommercialSegment("Quem ganhou o Nobel da Paz? E qual é a capital da França?")).toBeNull();
    expect(inferCommercialSegment("Conte uma história da mitologia")).toBeNull();
  });
});

describe("demo e transições", () => {
  it("encaminha restaurante e agenda somente pela capability demo_execution", () => {
    expect(commercialDemoGuidance("restaurant", false)).toContain("NÃO está autorizada");
    expect(commercialDemoGuidance("restaurant", true)).toContain("cardápio");
    expect(commercialDemoGuidance("clinic", true)).toContain("agenda");
  });

  it("Audit só qualifica com intenção comercial inequívoca", () => {
    for (const vague of ["sim", "legal", "interessante", "me explica melhor", "como funciona?", "talvez", "depois eu vejo", "tenho um restaurante", "como você me ajudaria?"]) {
      expect(explicitlyQualifiesAudit(vague)).toBe(false);
    }
    expect(explicitlyQualifiesAudit("Quero fazer uma demonstração")).toBe(true);
    expect(explicitlyQualifiesAudit("Gostaria de contratar a Lívia")).toBe(true);
    expect(explicitlyQualifiesAudit("Sim. Me mostra na prática como você atenderia um cliente meu querendo comprar balas e doces pelo WhatsApp.")).toBe(true);
    expect(explicitlyQualifiesAudit("Quero ver funcionando")).toBe(true);
    expect(explicitlyQualifiesAudit("Vamos fazer a demonstração")).toBe(true);
    expect(explicitlyQualifiesAudit("Pode me mostrar como funciona na prática?")).toBe(true);
    expect(explicitlyQualifiesAudit("Quero testar")).toBe(true);
    expect(explicitlyQualifiesAudit("Vamos testar")).toBe(true);
  });

  it("Audit -> Commercial preserva dados e boundary; nunca vira Operational por frase", () => {
    const current = audit({ audit: { leadsPerDay: 20, capturedAt: 100 } });
    const qualified = enrichCommercialContext({ context: current, text: "Quero testar a Lívia", now: 300, allowAuditQualification: true });
    expect(qualified.context).toMatchObject({ purpose: "commercial", source: "audit_calculator", enteredAt: 100, audit: { leadsPerDay: 20 } });
    expect(historyForConversationContext([
      { id: "old", role: "customer", text: "agendamento", at: 1 },
      { id: "audit", role: "customer", text: "auditoria", at: 100 },
      { id: "demo", role: "customer", text: "quero testar", at: 300 },
    ], { context: qualified.context, enteredAudit: false }).map((message) => message.id)).toEqual(["audit", "demo"]);
    expect(() => transitionConversationContext(current, "operational", "customer_activated", 400)).toThrow();
  });

  it("Commercial -> Operational continua exclusivo de customer_activated", () => {
    const commercial: ConversationContext = { purpose: "commercial", source: "prospecting", enteredAt: 1, updatedAt: 1 };
    expect(transitionConversationContext(commercial, "operational", "customer_activated", 2).purpose).toBe("operational");
    expect(() => transitionConversationContext(commercial, "operational", "audit_qualified", 2)).toThrow();
  });
});
