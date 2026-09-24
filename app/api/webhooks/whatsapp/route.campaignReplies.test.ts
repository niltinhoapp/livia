// CAMPANHAS-07: resposta do cliente correlacionada a CampaignRecipient.
// Prova que o hook roda no fluxo normal do webhook (mesmo endpoint, sem
// mudar timing) e, principalmente, que o fluxo normal da Lívia (IA,
// resposta, persistência da conversa) nunca é afetado pelo resultado da
// correlação — nem quando ela falha.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { ConversationTask, Establishment, WhatsAppInboundJob } from "@/types";

const APP_SECRET = "segredo-de-teste";
process.env.META_APP_SECRET = APP_SECRET;

vi.mock("@/lib/whatsapp/outbox", () => {
  class OutboundRetryableError extends Error { constructor(public code: string) { super(code); } }
  class OutboundReconciliationRequiredError extends Error { constructor(public code: string) { super(code); } }
  class OutboundIntentConflictError extends Error {}
  return { OutboundRetryableError, OutboundReconciliationRequiredError, OutboundIntentConflictError, getWhatsAppOutboundIntent: vi.fn(async () => null), executeDurableWhatsAppOutbound: vi.fn(async (input: { text: string }, sender: () => Promise<{ waMessageId?: string }>) => ({ ...(await sender()), text: input.text })) };
});

const findEstablishmentByPhoneNumberId = vi.fn();
const loadConversation = vi.fn();
const appendMessage = vi.fn();
const alreadyProcessed = vi.fn(async (_id: string) => false);
const tryAcquireConversationProcessingLease = vi.fn(async () => "lease-test");
const renewConversationProcessingLease = vi.fn(async () => true);
const releaseConversationProcessingLease = vi.fn(async () => undefined);
let inboundJobs: WhatsAppInboundJob[] = [];
const enqueueWhatsAppInboundJob = vi.fn(async (input: { waMessageId: string; establishmentId: string; conversationId: string; value: Record<string, unknown>; message: Record<string, unknown> }) => { const now = Date.now(); const job: WhatsAppInboundJob = { id: input.waMessageId, establishmentId: input.establishmentId, conversationId: input.conversationId, conversationKey: `${input.establishmentId}:${input.conversationId}`, sequence: inboundJobs.length + 1, receivedAt: now, whatsappPhoneNumberId: String((input.value.metadata as { phone_number_id?: string } | undefined)?.phone_number_id ?? ""), attempts: 0, nextAttemptAt: now, value: input.value, message: input.message }; if (!inboundJobs.some((item) => item.id === job.id)) inboundJobs.push(job); return { queued: true, sequence: job.sequence }; });
const correlateCampaignReply = vi.fn(async (..._a: unknown[]) => "no_match");
const think = vi.fn();
const sendText = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.bot" }));
const markAsRead = vi.fn();
const deriveTaskState = vi.fn(
  (input: { existingTask?: ConversationTask | null; booked: boolean }) =>
    input.booked ? null : (input.existingTask ?? null),
);

vi.mock("@/lib/repo", () => ({
  findEstablishmentByPhoneNumberId: (...a: unknown[]) => findEstablishmentByPhoneNumberId(...a),
  getEstablishment: (...a: unknown[]) => findEstablishmentByPhoneNumberId(...a),
  getConversation: vi.fn(async () => ({ id: "conv", status: "bot" })),
  getKnowledgeBase: vi.fn(async () => null),
  loadConversation: (...a: unknown[]) => loadConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  setConversationStatus: vi.fn(),
  closeConversation: vi.fn(),
  tryCloseAutomatedConversation: vi.fn(async () => true),
  reopenConversation: vi.fn(async () => undefined),
  setConversationIntent: vi.fn(),
  setConversationTask: vi.fn(),
  setConversationSummary: vi.fn(),
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(),
  upsertPendingTask: vi.fn(),
  resolvePendingTask: vi.fn(),
  getPendingTask: vi.fn(async () => null),
  alreadyProcessed: (...a: unknown[]) => alreadyProcessed(...(a as [string])),
  enqueueWhatsAppInboundJob,
  listWhatsAppInboundJobs: vi.fn(async () => inboundJobs),
  listRecoverableWhatsAppInboundJobs: vi.fn(async () => inboundJobs),
  completeWhatsAppInboundJob: vi.fn(async (job: WhatsAppInboundJob) => { inboundJobs = inboundJobs.filter((item) => item.id !== job.id); return true; }),
  failWhatsAppInboundJob: vi.fn(async () => "retry_scheduled"),
  quarantineOrphanWhatsAppInboundJobs: vi.fn(async () => 0),
  quarantineWhatsAppInboundSequenceGap: vi.fn(async () => true),
  tryAcquireConversationProcessingLease,
  renewConversationProcessingLease,
  releaseConversationProcessingLease,
  releaseConversationProcessingLeaseIfDrained: vi.fn(async () => true),
  transitionConversationStatusWithLease: vi.fn(async () => true),
  applyCampaignDeliveryStatus: vi.fn(async () => "not_found"),
  correlateCampaignReply: (...a: unknown[]) => correlateCampaignReply(...a),
  getProspectingSessionByPhone: vi.fn(async () => null),
  transitionProspectingSession: vi.fn(),
}));

vi.mock("@/lib/whatsapp/client", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  markAsRead: (...a: unknown[]) => markAsRead(...a),
  normalizePhone: (raw: string) => raw.replace(/\D/g, ""),
}));

vi.mock("@/lib/ai/brain", () => ({ think: (...a: unknown[]) => think(...a) }));
vi.mock("@/lib/ai/intent", () => ({
  detectIntent: () => ({ type: "general_question", confidence: 0.2, entities: {} }),
}));
vi.mock("@/lib/ai/taskState", () => ({
  deriveTaskState: (input: { existingTask?: ConversationTask | null; booked: boolean }) => deriveTaskState(input),
}));
vi.mock("@/lib/ai/pendingTask", () => ({ derivePendingTask: () => null }));
vi.mock("@/lib/ai/summarize", () => ({ summarizeConversation: vi.fn(async () => null) }));
vi.mock("@/lib/scheduling", () => ({
  findNextAppointment: vi.fn(async () => null),
  setStatus: vi.fn(),
  findCustomerNameFromAppointments: vi.fn(async () => null),
}));

const { POST } = await import("@/app/api/webhooks/whatsapp/route");

const PHONE = "5514991234567";
const PHONE_NUMBER_ID = "pn_1";

function establishment(over: Partial<Establishment> = {}): Establishment {
  return {
    id: "est_odonto",
    name: "Odonto Demo",
    type: "odonto",
    ownerUid: "uid",
    status: "active",
    createdAt: 0,
    whatsapp: { wabaId: "waba", phoneNumberId: PHONE_NUMBER_ID, status: "connected", accessToken: { ciphertext: "x", iv: "y", authTag: "z" } },
    bot: { personaName: "Livia", tone: "", bookingEnabled: true, medicalGuardrail: false },
    ...over,
  } as unknown as Establishment;
}

function assinar(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex");
}

function enviarPayload(body: unknown) {
  const json = JSON.stringify(body);
  const req = new Request("https://livia.test/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": assinar(json) },
    body: json,
  });
  return POST(req as never);
}

function payloadMensagem(overrides: { id?: string; text?: string } = {}) {
  return {
    entry: [{
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: "Ana" } }],
          messages: [{ id: overrides.id ?? "wamid.in", from: PHONE, type: "text", text: { body: overrides.text ?? "oi" } }],
        },
      }],
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  inboundJobs = [];
  appendMessage.mockImplementation(async (...args: unknown[]) => ({ id: String(args[4] ?? "message"), at: Date.now() }));
  alreadyProcessed.mockResolvedValue(false);
  correlateCampaignReply.mockResolvedValue("no_match");
  sendText.mockResolvedValue({ waMessageId: "wamid.bot" });
  findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
  loadConversation.mockResolvedValue({
    conversation: { id: PHONE, establishmentId: "est_odonto", contactPhone: PHONE, contactName: "Ana", status: "bot", lastMessageAt: 0, createdAt: 0 },
    history: [],
  });
  think.mockResolvedValue({ reply: "Claro!", handoff: false, booked: false, rescheduled: false, cancelled: false, toolCalls: [] });
});

describe("Campanhas-07 — correlação de reply no webhook", () => {
  it("13) mensagem inbound continua passando pelo fluxo normal (IA, resposta, persistência) mesmo havendo correlação de campanha", async () => {
    correlateCampaignReply.mockResolvedValue("applied");

    const res = await enviarPayload(payloadMensagem());

    expect(res.status).toBe(200);
    expect(correlateCampaignReply).toHaveBeenCalledWith("est_odonto", PHONE);
    // Fluxo normal da Lívia integralmente preservado.
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalled();
  });

  it("mensagem sem nenhuma campanha correlacionável (no_match) segue o fluxo normal sem diferença", async () => {
    correlateCampaignReply.mockResolvedValue("no_match");

    const res = await enviarPayload(payloadMensagem());

    expect(res.status).toBe(200);
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("falha na correlação de campanha nunca derruba o webhook nem impede a resposta ao cliente", async () => {
    correlateCampaignReply.mockRejectedValue(new Error("firestore indisponível"));

    const res = await enviarPayload(payloadMensagem());

    expect(res.status).toBe(200);
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalled();
  });

  it("correlação roda com o telefone bruto do remetente, no tenant já resolvido pela sessão (nunca de payload)", async () => {
    await enviarPayload(payloadMensagem());
    expect(correlateCampaignReply).toHaveBeenCalledWith("est_odonto", PHONE);
  });
});
