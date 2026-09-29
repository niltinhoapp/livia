import { describe, expect, it, vi } from "vitest";
import type { ConversationContext, Message, ProspectingSession } from "@/types";
import {
  capabilitiesForConversation,
  historyForConversationContext,
  resolveConversationContext,
  transitionConversationContext,
} from "./conversationPolicy";
import { carriesAuditResult } from "./commercialContext";
import { startsAuditContext } from "./contextSwitch";
import { isLiviaCommercialChannel } from "@/lib/prospectingChannel";

const context = (purpose: ConversationContext["purpose"], enteredAt = 100): ConversationContext => ({
  purpose,
  source: purpose === "audit" ? "audit_calculator" : purpose === "commercial" ? "prospecting" : "normal",
  enteredAt,
  updatedAt: enteredAt,
});

const session = (status: ProspectingSession["status"], expiresAt = 1_000): ProspectingSession => ({
  id: "5511999999999",
  establishmentId: "est",
  leadId: "lead",
  normalizedPhone: "5511999999999",
  businessName: "Restaurante",
  segment: "restaurante",
  initialManualMessage: "Oi",
  status,
  preRevealReplyCount: 0,
  preparedAt: 1,
  manualSendConfirmedAt: 2,
  firstReplyAt: 3,
  revealedAt: null,
  completedAt: null,
  expiresAt,
  outcome: null,
  createdAt: 1,
  updatedAt: 1,
});

describe("capability policy", () => {
  it("preserva agenda e pedidos habilitados no contexto operational", () => {
    const caps = capabilitiesForConversation({ context: context("operational"), bookingEnabled: true, ordersEnabled: true, demoAuthorized: false });
    expect(caps.agenda_read).toBe(true);
    expect(caps.agenda_mutate).toBe(true);
    expect(caps.order_read).toBe(true);
    expect(caps.order_mutate).toBe(true);
    expect(caps.customer_profile_mutate).toBe(true);
    expect(caps.commercial_guidance).toBe(false);
  });

  it("Audit bloqueia agenda, pedidos e perfil, preservando comercial e handoff", () => {
    const caps = capabilitiesForConversation({ context: context("audit"), bookingEnabled: true, ordersEnabled: true, demoAuthorized: true });
    expect(caps).toMatchObject({
      agenda_read: false,
      agenda_mutate: false,
      catalog_read: false,
      order_read: false,
      order_mutate: false,
      customer_profile_read: false,
      customer_profile_mutate: false,
      commercial_guidance: true,
      demo_execution: false,
      human_handoff: true,
    });
  });

  it("Commercial só recebe execução demo quando a autorização existente for válida", () => {
    const denied = capabilitiesForConversation({ context: context("commercial"), bookingEnabled: true, ordersEnabled: true, demoAuthorized: false });
    expect(denied.commercial_guidance).toBe(true);
    expect(denied.demo_execution).toBe(false);
    expect(denied.catalog_read).toBe(true);
    expect(denied.agenda_mutate).toBe(false);
    expect(denied.order_mutate).toBe(false);

    const allowed = capabilitiesForConversation({ context: context("commercial"), bookingEnabled: true, ordersEnabled: true, demoAuthorized: true });
    expect(allowed.demo_execution).toBe(true);
    expect(allowed.agenda_mutate).toBe(true);
    expect(allowed.order_mutate).toBe(true);
    expect(allowed.customer_profile_read).toBe(false);
  });
});

describe("persistent context precedence and transitions", () => {
  it("entrada Audit persiste semanticamente e limpa task operacional", () => {
    const resolved = resolveConversationContext({ commercialChannel: true, startsAudit: true, now: 100 });
    expect(resolved.context).toEqual(context("audit", 100));
    expect(resolved.changed).toBe(true);
    expect(resolved.enteredAudit).toBe(true);
    expect(resolved.clearOperationalTask).toBe(true);
  });

  it("segundo e terceiro turnos continuam Audit sem repetir a palavra", () => {
    const second = resolveConversationContext({ commercialChannel: true, persisted: context("audit", 100), startsAudit: false, now: 200 });
    const third = resolveConversationContext({ commercialChannel: true, persisted: second.context, startsAudit: false, now: 300 });
    expect(second.context).toEqual(context("audit", 100));
    expect(third.context).toEqual(context("audit", 100));
    expect(second.enteredAudit).toBe(false);
  });

  it("conversa antiga continua operational sem exigir backfill", () => {
    const resolved = resolveConversationContext({ commercialChannel: true, startsAudit: false, now: 100 });
    expect(resolved.context.purpose).toBe("operational");
    expect(resolved.changed).toBe(false);
  });

  it("ProspectingSession ativa produz Commercial; terminal não encerra contexto persistido", () => {
    const active = resolveConversationContext({ commercialChannel: true, prospectingSession: session("REVEALED"), startsAudit: false, now: 100 });
    expect(active.context.purpose).toBe("commercial");
    expect(active.context.source).toBe("prospecting");

    const terminal = resolveConversationContext({ commercialChannel: true, persisted: active.context, prospectingSession: session("CLOSED"), startsAudit: false, now: 200 });
    expect(terminal.context.purpose).toBe("commercial");
    expect(terminal.changed).toBe(false);
  });

  it("Audit persistido vence sessão ativa; nova entrada Audit vence todos", () => {
    expect(resolveConversationContext({ commercialChannel: true, persisted: context("audit"), prospectingSession: session("REVEALED"), startsAudit: false, now: 200 }).context.purpose).toBe("audit");
    expect(resolveConversationContext({ commercialChannel: true, persisted: context("commercial"), prospectingSession: session("REVEALED"), startsAudit: true, now: 200 }).context.purpose).toBe("audit");
  });

  it("só permite saídas explícitas com razões fortes", () => {
    expect(transitionConversationContext(context("audit"), "commercial", "audit_qualified", 200).purpose).toBe("commercial");
    expect(transitionConversationContext(context("commercial"), "operational", "customer_activated", 300).purpose).toBe("operational");
    expect(() => transitionConversationContext(context("audit"), "operational", "customer_activated", 300)).toThrow("invalid_conversation_context_transition");
  });
});

describe("Audit history boundary", () => {
  const messages: Message[] = [
    { id: "old", role: "bot", text: "Qual horário?", at: 10 },
    { id: "audit", role: "customer", text: "Fiz a Auditoria", at: 100 },
    { id: "business", role: "customer", text: "Tenho um restaurante", at: 200 },
    { id: "help", role: "customer", text: "Como você me ajudaria?", at: 300 },
  ];

  it("primeiro turno não recebe contaminação operacional", () => {
    expect(historyForConversationContext(messages.slice(0, 2), { context: context("audit"), enteredAudit: true }).map((m) => m.id)).toEqual(["audit"]);
  });

  it("segundo e terceiro turnos recebem todo o histórico da própria Audit", () => {
    expect(historyForConversationContext(messages.slice(0, 3), { context: context("audit"), enteredAudit: false }).map((m) => m.id)).toEqual(["audit", "business"]);
    expect(historyForConversationContext(messages, { context: context("audit"), enteredAudit: false }).map((m) => m.id)).toEqual(["audit", "business", "help"]);
  });
});

describe("canal comercial da Lívia × estabelecimento cliente", () => {
  it("C11: num estabelecimento cliente, 'diagnóstico'/'auditoria' não tiram a conversa do atendimento real", () => {
    for (const text of ["Quero agendar um diagnóstico", "Preciso de uma auditoria contábil", "Acabei de fazer a Auditoria de Atendimento. Leads por dia: 78"]) {
      const resolved = resolveConversationContext({ commercialChannel: false, startsAudit: startsAuditContext(text), freshAuditEntry: carriesAuditResult(text), now: 100 });
      expect(resolved).toMatchObject({ context: { purpose: "operational", source: "normal" }, changed: false, enteredAudit: false, clearOperationalTask: false });
    }
  });

  it("C11: conversa real que já tinha sido sequestrada para Audit/Commercial volta a operational sem perder a tarefa", () => {
    for (const persisted of [context("audit"), { ...context("commercial"), source: "audit_calculator" as const }]) {
      const resolved = resolveConversationContext({ persisted, commercialChannel: false, startsAudit: false, now: 200 });
      expect(resolved).toMatchObject({ context: { purpose: "operational", source: "normal" }, changed: true, enteredAudit: false, clearOperationalTask: false });
    }
  });

  it("estabelecimento cliente ignora ProspectingSession (que só nasce em tenant interno)", () => {
    expect(resolveConversationContext({ commercialChannel: false, prospectingSession: session("REVEALED"), startsAudit: false, now: 100 }).context.purpose).toBe("operational");
  });

  it("A2: resultado novo da Calculadora sobre Audit persistida reinicia a fronteira; menção simples não", () => {
    const fresh = resolveConversationContext({ persisted: { ...context("audit", 100), audit: { leadsPerDay: 1, capturedAt: 100 } }, commercialChannel: true, startsAudit: true, freshAuditEntry: true, now: 900 });
    expect(fresh).toMatchObject({ changed: true, enteredAudit: true, clearOperationalTask: true, context: { purpose: "audit", enteredAt: 900 } });
    expect(fresh.context.audit).toBeUndefined();

    const mention = resolveConversationContext({ persisted: context("audit", 100), commercialChannel: true, startsAudit: true, freshAuditEntry: false, now: 900 });
    expect(mention).toMatchObject({ changed: false, enteredAudit: false, context: { enteredAt: 100 } });
  });
});

describe("isLiviaCommercialChannel", () => {
  it("só os tenants internos (prospecção/demo) e o canal demo são comerciais", () => {
    vi.stubEnv("INTERNAL_PROSPECTING_ESTABLISHMENT_ID", "est-revenue");
    vi.stubEnv("INTERNAL_DEMO_PROSPECTING_ESTABLISHMENT_ID", "est-demo");
    expect(isLiviaCommercialChannel({ id: "est-revenue" })).toBe(true);
    expect(isLiviaCommercialChannel({ id: "est-demo" })).toBe(true);
    expect(isLiviaCommercialChannel({ id: "outro", demoChannel: { enabled: true } })).toBe(true);
    expect(isLiviaCommercialChannel({ id: "clinica-real" })).toBe(false);
    expect(isLiviaCommercialChannel({ id: "clinica-real", demoChannel: { enabled: false } })).toBe(false);
    vi.unstubAllEnvs();
  });

  it("sem env configurada, nenhum tenant comum vira canal comercial", () => {
    vi.stubEnv("INTERNAL_PROSPECTING_ESTABLISHMENT_ID", "");
    vi.stubEnv("INTERNAL_DEMO_PROSPECTING_ESTABLISHMENT_ID", "");
    expect(isLiviaCommercialChannel({ id: "" })).toBe(false);
    expect(isLiviaCommercialChannel({ id: "clinica-real" })).toBe(false);
    vi.unstubAllEnvs();
  });
});
