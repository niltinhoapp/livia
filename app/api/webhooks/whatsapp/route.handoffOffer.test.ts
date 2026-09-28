// F5.4 — uma OFERTA de atendente não é um handoff confirmado.
//
// Caso real (demonstração): depois de uma reclamação a Lívia ofereceu
// "Posso chamar uma pessoa da equipe para te ajudar com isso?". O cliente
// respondeu com um pedido novo ("quero o x-burger e 1 coca cola") e recebeu a
// MESMA oferta de novo. Duas causas: a mera oferta marcava a sessão de
// prospecção como HUMAN (terminal), então o turno seguinte perdia o contexto
// da demonstração; e nada impedia o modelo de reabrir a oferta que o cliente
// acabara de deixar de lado. Aqui se prova, pelo POST assinado, que:
//   - a oferta mantém a sessão viva (sem HUMAN);
//   - um pedido novo encerra a oferta e chega ao cérebro sem human_handoff;
//   - o aceite ("sim, quero falar com alguém") continua transferindo (F4) e só
//     então a sessão vira HUMAN, com a pendência awaiting_human no painel.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Establishment, Message, ProspectingSession, WhatsAppInboundJob } from "@/types";

const APP_SECRET = "segredo-de-teste";
process.env.META_APP_SECRET = APP_SECRET;

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

vi.mock("@/lib/whatsapp/outbox", () => {
  class OutboundRetryableError extends Error { constructor(public code: string) { super(code); } }
  class OutboundReconciliationRequiredError extends Error { constructor(public code: string) { super(code); } }
  class OutboundIntentConflictError extends Error {}
  return { OutboundRetryableError, OutboundReconciliationRequiredError, OutboundIntentConflictError, getWhatsAppOutboundIntent: vi.fn(async () => null), executeDurableWhatsAppOutbound: vi.fn(async (input: { text: string }, sender: () => Promise<{ waMessageId?: string }>) => ({ ...(await sender()), text: input.text })) };
});

const findEstablishmentByPhoneNumberId = vi.fn();
const loadConversation = vi.fn();
const appendMessage = vi.fn();
const setConversationStatus = vi.fn();
const setAwaitingHumanOfferConfirmation = vi.fn();
const upsertPendingTask = vi.fn();
const getProspectingSessionByPhone = vi.fn(async (..._a: unknown[]): Promise<ProspectingSession | null> => null);
const transitionProspectingSession = vi.fn(async (..._a: unknown[]) => null);
let inboundJobs: WhatsAppInboundJob[] = [];
const enqueueWhatsAppInboundJob = vi.fn(async (input: { waMessageId: string; establishmentId: string; conversationId: string; value: Record<string, unknown>; message: Record<string, unknown> }) => { const now = Date.now(); const job: WhatsAppInboundJob = { id: input.waMessageId, establishmentId: input.establishmentId, conversationId: input.conversationId, conversationKey: `${input.establishmentId}:${input.conversationId}`, sequence: inboundJobs.length + 1, receivedAt: now, whatsappPhoneNumberId: String((input.value.metadata as { phone_number_id?: string } | undefined)?.phone_number_id ?? ""), attempts: 0, nextAttemptAt: now, value: input.value, message: input.message }; if (!inboundJobs.some((item) => item.id === job.id)) inboundJobs.push(job); return { queued: true, sequence: job.sequence }; });
const think = vi.fn();
const sendText = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.bot" }));

vi.mock("@/lib/repo", () => ({
  findEstablishmentByPhoneNumberId: (...a: unknown[]) => findEstablishmentByPhoneNumberId(...a),
  getEstablishment: (...a: unknown[]) => findEstablishmentByPhoneNumberId(...a),
  getConversation: vi.fn(async () => null),
  getKnowledgeBase: vi.fn(async () => null),
  loadConversation: (...a: unknown[]) => loadConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  setConversationStatus: (...a: unknown[]) => setConversationStatus(...a),
  setAwaitingHumanOfferConfirmation: (...a: unknown[]) => setAwaitingHumanOfferConfirmation(...a),
  setConversationIntent: vi.fn(),
  setConversationTask: vi.fn(),
  setConversationSummary: vi.fn(),
  setConversationContext: vi.fn(),
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(),
  upsertPendingTask: (...a: unknown[]) => upsertPendingTask(...a),
  resolvePendingTask: vi.fn(),
  alreadyProcessed: vi.fn(async () => false),
  enqueueWhatsAppInboundJob,
  listWhatsAppInboundJobs: vi.fn(async () => inboundJobs),
  listRecoverableWhatsAppInboundJobs: vi.fn(async () => inboundJobs),
  completeWhatsAppInboundJob: vi.fn(async (job: WhatsAppInboundJob) => { inboundJobs = inboundJobs.filter((item) => item.id !== job.id); return true; }),
  failWhatsAppInboundJob: vi.fn(async () => "retry_scheduled"),
  quarantineOrphanWhatsAppInboundJobs: vi.fn(async () => 0),
  quarantineWhatsAppInboundSequenceGap: vi.fn(async () => true),
  tryAcquireConversationProcessingLease: vi.fn(async () => "lease-test"),
  renewConversationProcessingLease: vi.fn(async () => true),
  releaseConversationProcessingLease: vi.fn(async () => undefined),
  releaseConversationProcessingLeaseIfDrained: vi.fn(async () => true),
  transitionConversationStatusWithLease: vi.fn(async (...a: unknown[]) => { await setConversationStatus(a[0], a[1], a[4]); return true; }),
  applyCampaignDeliveryStatus: vi.fn(async () => "not_found"),
  correlateCampaignReply: vi.fn(async () => "no_match"),
  getProspectingSessionByPhone: (...a: unknown[]) => getProspectingSessionByPhone(...a),
  transitionProspectingSession: (...a: unknown[]) => transitionProspectingSession(...a),
  incrementProspectingPreRevealCount: vi.fn(async () => undefined),
  reactivateProspectingSessionForDemo: vi.fn(async () => null),
}));

vi.mock("@/lib/whatsapp/client", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  markAsRead: vi.fn(),
  normalizePhone: (raw: string) => raw.replace(/\D/g, ""),
}));

vi.mock("@/lib/ai/brain", () => ({ think: (...a: unknown[]) => think(...a) }));
vi.mock("@/lib/ai/intent", () => ({ detectIntent: () => ({ type: "other" }) }));
vi.mock("@/lib/ai/taskState", () => ({ deriveTaskState: () => null }));
vi.mock("@/lib/ai/pendingTask", () => ({ derivePendingTask: () => null }));
vi.mock("@/lib/ai/summarize", () => ({ summarizeConversation: vi.fn(async () => null) }));
vi.mock("@/lib/scheduling", () => ({
  findNextAppointment: vi.fn(async () => null),
  setStatus: vi.fn(),
}));

const { POST } = await import("@/app/api/webhooks/whatsapp/route");

const PHONE = "5514991234567";
const OFERTA = "Posso chamar uma pessoa da equipe para te ajudar com isso?";

function establishment(): Establishment {
  return {
    id: "est_demo",
    name: "Lanchonete Demo",
    type: "restaurante",
    ownerUid: "uid",
    status: "active",
    createdAt: 0,
    whatsapp: {
      wabaId: "waba",
      phoneNumberId: "pn_1",
      status: "connected",
      accessToken: { ciphertext: "x", iv: "y", authTag: "z" },
    },
    bot: { personaName: "Livia", tone: "", bookingEnabled: true, ordersEnabled: true, medicalGuardrail: false },
  } as unknown as Establishment;
}

function revealedSession(): ProspectingSession {
  const now = Date.now();
  return {
    leadId: "lead-1",
    normalizedPhone: PHONE,
    businessName: "Lanchonete do Zé",
    segment: "restaurant",
    initialManualMessage: "Oi!",
    preRevealReplyCount: 1,
    status: "REVEALED",
    preparedAt: now - 60_000,
    manualSendConfirmedAt: now - 50_000,
    firstReplyAt: now - 40_000,
    revealedAt: now - 30_000,
    expiresAt: now + 24 * 60 * 60 * 1000,
  } as unknown as ProspectingSession;
}

function conversa(history: Message[] = [], awaitingHumanOfferConfirmation = false) {
  return {
    conversation: {
      id: PHONE, establishmentId: "est_demo", contactPhone: PHONE, contactName: "Ana", status: "bot", lastMessageAt: 0, createdAt: 0,
      ...(awaitingHumanOfferConfirmation ? { awaitingHumanOfferConfirmation: true } : {}),
    },
    history,
  };
}

async function entregar(texto: string, msgId = `wamid.${Math.random()}`) {
  const body = JSON.stringify({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "pn_1" },
      contacts: [{ profile: { name: "Ana" } }],
      messages: [{ id: msgId, from: PHONE, type: "text", text: { body: texto } }],
    } }] }],
  });
  const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex");
  const req = new Request("https://livia.test/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body,
  });
  return POST(req as never);
}

function textosEnviados(): string[] {
  return sendText.mock.calls.map((c) => (c as unknown[])[3] as string);
}

function humanOutcomeCalls() {
  return transitionProspectingSession.mock.calls.filter((c) => {
    const action = c[2] as { action?: string; status?: string } | undefined;
    return action?.action === "set_outcome" && action.status === "HUMAN";
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  inboundJobs = [];
  appendMessage.mockImplementation(async (...args: unknown[]) => ({ id: String(args[4] ?? "message"), at: Date.now() }));
  sendText.mockResolvedValue({ waMessageId: "wamid.bot" });
  findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
  getProspectingSessionByPhone.mockResolvedValue(revealedSession());
  think.mockResolvedValue({
    reply: "Anotei 1 X-Burger e 1 Coca-Cola lata 350ml no seu pedido!",
    handoff: false, booked: false, rescheduled: false, cancelled: false, toolCalls: [],
  });
});

describe("F5.4 — oferta de atendente não é handoff confirmado", () => {
  it("a oferta não encerra a sessão de prospecção (sem HUMAN) nem muda o status", async () => {
    loadConversation.mockResolvedValue(conversa());
    think.mockResolvedValue({
      reply: "Vou chamar uma pessoa da equipe para te ajudar.", handoff: true,
      booked: false, rescheduled: false, cancelled: false, toolCalls: [],
    });

    await entregar("hum, ficou complicado, você tinha conferido a agenda e agora não tem mais");

    expect(textosEnviados()).toEqual([OFERTA]);
    expect(setAwaitingHumanOfferConfirmation).toHaveBeenCalledWith("est_demo", PHONE, true, expect.objectContaining({ leaseId: "lease-test" }));
    expect(setConversationStatus).not.toHaveBeenCalled();
    expect(humanOutcomeCalls()).toHaveLength(0);
  });

  it("pedido novo com oferta pendente: a oferta fecha, a demo continua e o pedido é atendido", async () => {
    loadConversation.mockResolvedValue(conversa([{ id: "b1", role: "bot", text: OFERTA, at: 1 }], true));

    await entregar("quero o x-burger e 1 coca cola");

    expect(setAwaitingHumanOfferConfirmation).toHaveBeenCalledWith("est_demo", PHONE, false, expect.objectContaining({ leaseId: "lease-test" }));
    expect(think).toHaveBeenCalledTimes(1);
    const input = think.mock.calls[0]![0] as { capabilities?: Record<string, boolean>; prospectingContext?: { status: string } };
    // A sessão da demonstração continua carregada (não virou HUMAN na oferta).
    expect(input.prospectingContext?.status).toBe("REVEALED");
    // E a mesma oferta não pode ser reaberta neste turno.
    expect(input.capabilities?.human_handoff).toBe(false);
    expect(textosEnviados()).toEqual(["Anotei 1 X-Burger e 1 Coca-Cola lata 350ml no seu pedido!"]);
    expect(setConversationStatus).not.toHaveBeenCalled();
    expect(upsertPendingTask).not.toHaveBeenCalledWith("est_demo", PHONE, PHONE, expect.objectContaining({ type: "awaiting_human" }));
    expect(humanOutcomeCalls()).toHaveLength(0);
  });

  it("sem oferta pendente, o cérebro continua podendo transferir (capability preservada)", async () => {
    loadConversation.mockResolvedValue(conversa());

    await entregar("quero o x-burger");

    const input = think.mock.calls[0]![0] as { capabilities?: Record<string, boolean> };
    expect(input.capabilities?.human_handoff).toBe(true);
  });

  it("F4 preservado: 'sim, quero falar com alguém' confirma — handoff, awaiting_human e sessão HUMAN", async () => {
    loadConversation.mockResolvedValue(conversa([{ id: "b1", role: "bot", text: OFERTA, at: 1 }], true));

    await entregar("sim, quero falar com alguém");

    expect(setAwaitingHumanOfferConfirmation).toHaveBeenCalledWith("est_demo", PHONE, false);
    expect(setConversationStatus).toHaveBeenCalledWith("est_demo", PHONE, "handoff");
    expect(upsertPendingTask).toHaveBeenCalledWith("est_demo", PHONE, PHONE, expect.objectContaining({ type: "awaiting_human" }));
    expect(humanOutcomeCalls()).toHaveLength(1);
    expect(think).not.toHaveBeenCalled();
    expect(textosEnviados()).toEqual(["Certo! Vou chamar uma pessoa da equipe para te ajudar por aqui."]);
  });

  it("pedido explícito de atendente sem oferta continua transferindo direto e marca HUMAN", async () => {
    loadConversation.mockResolvedValue(conversa());
    think.mockResolvedValue({
      reply: "Certo, vou chamar uma pessoa da equipe.", handoff: true,
      booked: false, rescheduled: false, cancelled: false, toolCalls: [],
    });

    await entregar("quero falar com um atendente");

    expect(setConversationStatus).toHaveBeenCalledWith("est_demo", PHONE, "handoff");
    expect(humanOutcomeCalls()).toHaveLength(1);
  });
});
