import { describe, expect, it } from "vitest";
import type { ConversationContext, Message, ProspectingSession } from "@/types";
import {
  capabilitiesForConversation,
  historyForConversationContext,
  resolveConversationContext,
  transitionConversationContext,
} from "./conversationPolicy";

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
    const resolved = resolveConversationContext({ startsAudit: true, now: 100 });
    expect(resolved.context).toEqual(context("audit", 100));
    expect(resolved.changed).toBe(true);
    expect(resolved.enteredAudit).toBe(true);
    expect(resolved.clearOperationalTask).toBe(true);
  });

  it("segundo e terceiro turnos continuam Audit sem repetir a palavra", () => {
    const second = resolveConversationContext({ persisted: context("audit", 100), startsAudit: false, now: 200 });
    const third = resolveConversationContext({ persisted: second.context, startsAudit: false, now: 300 });
    expect(second.context).toEqual(context("audit", 100));
    expect(third.context).toEqual(context("audit", 100));
    expect(second.enteredAudit).toBe(false);
  });

  it("conversa antiga continua operational sem exigir backfill", () => {
    const resolved = resolveConversationContext({ startsAudit: false, now: 100 });
    expect(resolved.context.purpose).toBe("operational");
    expect(resolved.changed).toBe(false);
  });

  it("ProspectingSession ativa produz Commercial; terminal não encerra contexto persistido", () => {
    const active = resolveConversationContext({ prospectingSession: session("REVEALED"), startsAudit: false, now: 100 });
    expect(active.context.purpose).toBe("commercial");
    expect(active.context.source).toBe("prospecting");

    const terminal = resolveConversationContext({ persisted: active.context, prospectingSession: session("CLOSED"), startsAudit: false, now: 200 });
    expect(terminal.context.purpose).toBe("commercial");
    expect(terminal.changed).toBe(false);
  });

  it("Audit persistido vence sessão ativa; nova entrada Audit vence todos", () => {
    expect(resolveConversationContext({ persisted: context("audit"), prospectingSession: session("REVEALED"), startsAudit: false, now: 200 }).context.purpose).toBe("audit");
    expect(resolveConversationContext({ persisted: context("commercial"), prospectingSession: session("REVEALED"), startsAudit: true, now: 200 }).context.purpose).toBe("audit");
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
