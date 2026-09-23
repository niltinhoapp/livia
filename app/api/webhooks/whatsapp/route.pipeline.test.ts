// Cobertura do pipeline completo do webhook (auditoria de 04/09/2026: um
// POST real da Meta voltava 200 em ~8ms, sem nenhuma chamada externa — a
// mensagem nunca chegava a ser processada, e nada nos logs dizia por quê).
//
// Estes testes provam que "POST 200" e "mensagem processada" são coisas
// diferentes: cada cenário confirma o que REALMENTE aconteceu (think foi
// chamado? sendText foi chamado? o erro subiu ou foi engolido?), não só o
// status HTTP da resposta.
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Conversation, ConversationTask, Establishment, Message } from "@/types";

const APP_SECRET = "segredo-de-teste";
process.env.META_APP_SECRET = APP_SECRET;

// ---- dublês ----
const findEstablishmentByPhoneNumberId = vi.fn();
const getEstablishment = vi.fn();
const getConversation = vi.fn();
const loadConversation = vi.fn();
const appendMessage = vi.fn();
const setConversationTask = vi.fn();
const setConversationStatus = vi.fn();
const setAwaitingHumanOfferConfirmation = vi.fn();
const setConversationIntent = vi.fn();
const upsertCustomerProfile = vi.fn();
const upsertPendingTask = vi.fn();
const resolvePendingTask = vi.fn();
const alreadyProcessed = vi.fn(async (_id: string) => false);
const tryAcquireConversationProcessingLease = vi.fn(async (): Promise<string | null> => "lease-test");
const renewConversationProcessingLease = vi.fn(async () => true);
const releaseConversationProcessingLease = vi.fn(async () => undefined);
const closeConversation = vi.fn();
const tryCloseAutomatedConversation = vi.fn(async (..._a: unknown[]) => true);
const reopenConversation = vi.fn(async (..._a: unknown[]) => undefined);
const getPendingTask = vi.fn(
  async (..._a: unknown[]): Promise<{ status: "open" | "resolved" } | null> => null,
);
const think = vi.fn();
const sendText = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.bot" }));
const sendAudio = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.audio" }));
const synthesizeSpeech = vi.fn(async (..._a: unknown[]) => ({ bytes: new Uint8Array([1, 2]), mimeType: "audio/ogg", provider: "openai", model: "gpt-4o-mini-tts", voice: "coral" }));
const markAsRead = vi.fn();
const downloadWhatsAppAudio = vi.fn();
const downloadWhatsAppMedia = vi.fn();
const storeConversationAttachment = vi.fn();
const deleteConversationAttachment = vi.fn();
const transcribeAudio = vi.fn();
const detectIntent = vi.fn((_text: string) => ({ type: "general_question", confidence: 0.2, entities: {} }));
const findNextAppointment = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
const setStatus = vi.fn();
const deriveTaskState = vi.fn(
  (input: { existingTask?: ConversationTask | null; booked: boolean }) =>
    input.booked ? null : (input.existingTask ?? null),
);

vi.mock("@/lib/repo", () => ({
  findEstablishmentByPhoneNumberId: (...a: unknown[]) => findEstablishmentByPhoneNumberId(...a),
  getEstablishment: (...a: unknown[]) => getEstablishment(...a),
  getConversation: (...a: unknown[]) => getConversation(...a),
  getKnowledgeBase: vi.fn(async () => null),
  loadConversation: (...a: unknown[]) => loadConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  setConversationStatus: (...a: unknown[]) => setConversationStatus(...a),
  setAwaitingHumanOfferConfirmation: (...a: unknown[]) => setAwaitingHumanOfferConfirmation(...a),
  closeConversation: (...a: unknown[]) => closeConversation(...a),
  tryCloseAutomatedConversation: (...a: unknown[]) => tryCloseAutomatedConversation(...a),
  reopenConversation: (...a: unknown[]) => reopenConversation(...a),
  setConversationIntent: (...a: unknown[]) => setConversationIntent(...a),
  setConversationTask: (...a: unknown[]) => setConversationTask(...a),
  setConversationSummary: vi.fn(),
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: (...a: unknown[]) => upsertCustomerProfile(...a),
  upsertPendingTask: (...a: unknown[]) => upsertPendingTask(...a),
  resolvePendingTask: (...a: unknown[]) => resolvePendingTask(...a),
  getPendingTask: (...a: unknown[]) => getPendingTask(...a),
  alreadyProcessed: (...a: unknown[]) => alreadyProcessed(...(a as [string])),
  tryAcquireConversationProcessingLease,
  renewConversationProcessingLease,
  releaseConversationProcessingLease,
  applyCampaignDeliveryStatus: vi.fn(async () => "not_found"),
  correlateCampaignReply: vi.fn(async () => "no_match"),
}));

vi.mock("@/lib/whatsapp/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsapp/client")>()),
  sendText: (...a: unknown[]) => sendText(...a),
  sendAudio: (...a: unknown[]) => sendAudio(...a),
  markAsRead: (...a: unknown[]) => markAsRead(...a),
  downloadWhatsAppAudio: (...a: unknown[]) => downloadWhatsAppAudio(...a),
  downloadWhatsAppMedia: (...a: unknown[]) => downloadWhatsAppMedia(...a),
  normalizePhone: (raw: string) => raw.replace(/\D/g, ""),
}));
vi.mock("@/lib/attachments/storage", () => ({
  AttachmentStorageError: class AttachmentStorageError extends Error {
    constructor(public readonly code: string) { super(code); }
  },
  storeConversationAttachment: (...a: unknown[]) => storeConversationAttachment(...a),
  deleteConversationAttachment: (...a: unknown[]) => deleteConversationAttachment(...a),
}));
vi.mock("@/lib/orderNotifications", () => ({ applyOrderNotificationDeliveryStatus: vi.fn(async () => "no_match") }));

vi.mock("@/lib/ai/brain", () => ({ think: (...a: unknown[]) => think(...a) }));
vi.mock("@/lib/ai/intent", () => ({ detectIntent: (text: string) => detectIntent(text) }));
vi.mock("@/lib/ai/transcription", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/transcription")>()),
  transcribeAudio: (...a: unknown[]) => transcribeAudio(...a),
}));
vi.mock("@/lib/ai/speech", () => ({ SpeechError: class SpeechError extends Error { constructor(public readonly code: string) { super(code); } }, synthesizeSpeech: (...a: unknown[]) => synthesizeSpeech(...a) }));
vi.mock("@/lib/ai/taskState", () => ({
  deriveTaskState: (input: { existingTask?: ConversationTask | null; booked: boolean }) => deriveTaskState(input),
}));
vi.mock("@/lib/ai/pendingTask", () => ({ derivePendingTask: () => null }));
vi.mock("@/lib/ai/summarize", () => ({ summarizeConversation: vi.fn(async () => null) }));
vi.mock("@/lib/scheduling", () => ({
  findNextAppointment: (...a: unknown[]) => findNextAppointment(...a),
  setStatus: (...a: unknown[]) => setStatus(...a),
  findCustomerNameFromAppointments: vi.fn(async () => null),
}));

const { POST } = await import("@/app/api/webhooks/whatsapp/route");
const { WhatsAppAudioSendError } = await import("@/lib/whatsapp/client");

// ---- helpers ----
const PHONE = "5514991234567";

function establishment(over: Partial<Establishment> = {}): Establishment {
  return {
    id: "est_odonto",
    name: "Odonto Demo",
    type: "odonto",
    ownerUid: "uid",
    status: "active",
    createdAt: 0,
    whatsapp: {
      wabaId: "waba",
      phoneNumberId: "pn_1",
      status: "connected",
      accessToken: { ciphertext: "x", iv: "y", authTag: "z" },
    },
    bot: { personaName: "Livia", tone: "", bookingEnabled: true, medicalGuardrail: false },
    ...over,
  } as unknown as Establishment;
}

function conversa(
  status: "bot" | "handoff" | "human" | "closed" = "bot",
  task?: ConversationTask,
  history: Message[] = [],
  extras: Record<string, unknown> = {},
) {
  return {
    conversation: {
      id: PHONE,
      establishmentId: "est_odonto",
      contactPhone: PHONE,
      contactName: "Ana",
      status,
      lastMessageAt: 0,
      createdAt: 0,
      ...(task ? { task } : {}),
      ...extras,
    },
    history,
  };
}

function assinar(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex");
}

// Corpo arbitrário — permite simular mensagem de texto, mensagem sem texto,
// status update e evento desconhecido com o mesmo helper.
function enviarPayload(body: unknown) {
  const json = JSON.stringify(body);
  const req = new Request("https://livia.test/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": assinar(json) },
    body: json,
  });
  return POST(req as never);
}

function payloadMensagem(overrides: { type?: string; omitText?: boolean; id?: string; text?: string } = {}) {
  const msg: Record<string, unknown> = {
    id: overrides.id ?? "wamid.1",
    from: PHONE,
    type: overrides.type ?? "text",
  };
  if (!overrides.omitText) msg.text = { body: overrides.text ?? "cancela esse" };
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "pn_1" },
              contacts: [{ profile: { name: "Ana" } }],
              messages: [msg],
            },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tryAcquireConversationProcessingLease.mockResolvedValue("lease-test");
  renewConversationProcessingLease.mockResolvedValue(true);
  releaseConversationProcessingLease.mockResolvedValue(undefined);
  alreadyProcessed.mockResolvedValue(false);
  tryCloseAutomatedConversation.mockResolvedValue(true);
  getPendingTask.mockResolvedValue(null);
  sendText.mockResolvedValue({ waMessageId: "wamid.bot" });
  sendAudio.mockResolvedValue({ waMessageId: "wamid.audio" });
  synthesizeSpeech.mockResolvedValue({ bytes: new Uint8Array([1, 2]), mimeType: "audio/ogg", provider: "openai", model: "gpt-4o-mini-tts", voice: "coral" });
  downloadWhatsAppAudio.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg", sizeBytes: 3 });
  downloadWhatsAppMedia.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", sizeBytes: 3 });
  storeConversationAttachment.mockImplementation(async (input: {
    type: "image" | "document"; mimeType: string; filename?: string; metaMediaId: string;
  }) => ({
    id: "attachment-1",
    type: input.type,
    mimeType: input.mimeType,
    filename: input.filename ?? (input.type === "image" ? "anexo.jpg" : "anexo.pdf"),
    sizeBytes: 3,
    metaMediaId: input.metaMediaId,
    storageRef: `establishments/est_odonto/conversations/${PHONE}/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.${input.type === "image" ? "jpg" : "pdf"}`,
    createdAt: 10,
  }));
  transcribeAudio.mockResolvedValue({ text: "Quero marcar uma avaliação amanhã às dez", provider: "openai", model: "gpt-4o-mini-transcribe" });
  detectIntent.mockReturnValue({ type: "general_question", confidence: 0.2, entities: {} });
  findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
  getEstablishment.mockResolvedValue(establishment());
  loadConversation.mockResolvedValue(conversa("bot"));
  getConversation.mockResolvedValue(conversa("bot").conversation);
  findNextAppointment.mockResolvedValue(null);
  think.mockResolvedValue({
    reply: "Claro! Posso te ajudar com isso.",
    handoff: false,
    booked: false,
    rescheduled: false,
    cancelled: false,
    toolCalls: [],
  });
});

describe("OT pré-comercialização — serialização e handoff durante IA", () => {
  it("duas mensagens simultâneas da mesma conversa não disparam duas respostas independentes", async () => {
    let releaseThink!: () => void;
    think.mockImplementationOnce(() => new Promise((resolve) => { releaseThink = () => resolve({
      reply: "Resposta consolidada", handoff: false, booked: false, rescheduled: false, cancelled: false, toolCalls: [],
    }); }));
    tryAcquireConversationProcessingLease.mockResolvedValueOnce("lease-a").mockResolvedValueOnce(null);

    const first = enviarPayload(payloadMensagem({ id: "wamid.serial.a", text: "quero às 15h" }));
    await vi.waitFor(() => expect(think).toHaveBeenCalledTimes(1));
    const second = enviarPayload(payloadMensagem({ id: "wamid.serial.b", text: "melhor às 16h" }));
    await second;

    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    releaseThink();
    await first;
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(releaseConversationProcessingLease).toHaveBeenCalledWith("est_odonto", PHONE, "lease-a");
  });

  it("falha no processamento libera a lease para que a conversa não fique travada", async () => {
    think.mockRejectedValueOnce(new Error("falha controlada da IA"));
    await enviarPayload(payloadMensagem({ id: "wamid.serial.failure", text: "oi" }));
    expect(releaseConversationProcessingLease).toHaveBeenCalledWith("est_odonto", PHONE, "lease-test");
  });

  it.each(["human", "handoff"] as const)("%s assumido durante think descarta resposta e não persiste ação posterior", async (status) => {
    let releaseThink!: () => void;
    think.mockImplementationOnce(() => new Promise((resolve) => { releaseThink = () => resolve({
      reply: "Resposta que não pode sair", handoff: false, booked: false, rescheduled: false, cancelled: false, toolCalls: [],
    }); }));

    const processing = enviarPayload(payloadMensagem({ id: `wamid.handoff.${status}`, text: "quero marcar" }));
    await vi.waitFor(() => expect(think).toHaveBeenCalledTimes(1));
    // Representa a leitura transacional autoritativa depois do clique do CRM.
    getConversation.mockResolvedValue({ ...conversa("bot").conversation, status });
    renewConversationProcessingLease.mockResolvedValue(false);
    releaseThink();
    await processing;

    expect(sendText).not.toHaveBeenCalled();
    expect(setConversationIntent).not.toHaveBeenCalled();
    expect(setConversationTask).not.toHaveBeenCalled();
  });
});

describe("OT-03F-R1 — encerramento bot ↔ bot", () => {
  it("reproduz o loop real: uma despedida e silêncio em todas as mensagens posteriores", async () => {
    let closed = false;
    loadConversation.mockImplementation(async () =>
      conversa(closed ? "closed" : "bot", undefined, [], closed ? { closedReason: "automated_recipient" } : {}),
    );
    tryCloseAutomatedConversation.mockImplementation(async () => {
      if (closed) return false;
      closed = true;
      return true;
    });

    await enviarPayload(payloadMensagem({
      id: "wamid.remote.intro",
      text: "Oi, Lívia! Sou a assistente virtual do STUDIO E NAILS. Obrigada pelo contato, mas esse canal é exclusivo para atendimento dos nossos clientes. Posso te ajudar com algum agendamento?",
    }));
    await enviarPayload(payloadMensagem({ id: "wamid.remote.thanks", text: "Obrigada, Lívia! Qualquer coisa que precisar, é só chamar." }));
    await enviarPayload(payloadMensagem({ id: "wamid.remote.bye", text: "Até mais!" }));
    await enviarPayload(payloadMensagem({ id: "wamid.remote.tchau", text: "Tchau!" }));

    expect(tryCloseAutomatedConversation).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[3]).toBe("Entendido! Vou encerrar por aqui. Até mais!");
    expect(think).not.toHaveBeenCalled();
  });

  it("dois webhooks concorrentes de automação produzem no máximo uma despedida", async () => {
    tryCloseAutomatedConversation.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await Promise.all([
      enviarPayload(payloadMensagem({ id: "wamid.bot.a", text: "Sou uma assistente virtual." })),
      enviarPayload(payloadMensagem({ id: "wamid.bot.b", text: "Sou uma assistente virtual." })),
    ]);

    expect(tryCloseAutomatedConversation).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(think).not.toHaveBeenCalled();
  });

  it("impede o webhook B desatualizado de chegar à IA após A fechar destinatário automatizado", async () => {
    let persistedConversation: Conversation = conversa("bot").conversation;
    let releaseB!: () => void;
    let bReachedAuthoritativeRead!: () => void;
    const bMayContinue = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const bAtAuthoritativeRead = new Promise<void>((resolve) => {
      bReachedAuthoritativeRead = resolve;
    });

    // Este armazenamento em memória representa o documento compartilhado:
    // B já leu "bot", A vence a transição atômica e a releitura de B observa
    // a persistência resultante, não o objeto local antigo.
    loadConversation.mockResolvedValue({ conversation: persistedConversation, history: [] });
    tryCloseAutomatedConversation.mockImplementation(async () => {
      if (persistedConversation.status !== "bot") return false;
      persistedConversation = {
        ...persistedConversation,
        status: "closed",
        closedReason: "automated_recipient",
      };
      return true;
    });
    getConversation.mockImplementation(async () => {
      bReachedAuthoritativeRead();
      await bMayContinue;
      return persistedConversation;
    });

    const webhookB = enviarPayload(payloadMensagem({
      id: "wamid.concurrent.human-like",
      text: "Oi! Posso ajudar você com um agendamento?",
    }));
    await bAtAuthoritativeRead;

    await enviarPayload(payloadMensagem({
      id: "wamid.concurrent.automated",
      text: "Sou a assistente virtual do Studio E Nails",
    }));

    releaseB();
    await webhookB;

    expect(tryCloseAutomatedConversation).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(think).not.toHaveBeenCalled();
    expect(persistedConversation).toMatchObject({
      status: "closed",
      closedReason: "automated_recipient",
    });
  });

  it("cliente humano segue para o processamento normal", async () => {
    await enviarPayload(payloadMensagem({ id: "wamid.human.normal", text: "quero marcar amanhã" }));

    expect(think).toHaveBeenCalledTimes(1);
  });

  it("reabre automated_recipient apenas para uma demanda humana clara", async () => {
    loadConversation.mockResolvedValue(conversa("closed", undefined, [], { closedReason: "automated_recipient" }));

    await enviarPayload(payloadMensagem({ id: "wamid.human", text: "quero marcar um horário amanhã" }));

    expect(reopenConversation).toHaveBeenCalledWith("est_odonto", PHONE);
    expect(think).toHaveBeenCalledTimes(1);
  });

  it("despedida social após resposta conclusiva não chama IA nem WhatsApp", async () => {
    loadConversation.mockResolvedValue(
      conversa("bot", undefined, [{ id: "bot.1", role: "bot", text: "Tudo certo. Quando quiser, é só chamar!", at: 1 }]),
    );

    await enviarPayload(payloadMensagem({ id: "wamid.social", text: "não preciso de nada, obrigada" }));

    expect(closeConversation).toHaveBeenCalledWith("est_odonto", PHONE, "social_farewell");
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("lifecycle de ConversationTask concluida", () => {
  const activeTask: ConversationTask = {
    type: "schedule_appointment",
    state: "confirm",
    collectedData: { date: "2026-09-15", serviceName: "Limpeza" },
    missingData: [],
    updatedAt: 1,
  };

  it.each([
    ["create", { booked: true, rescheduled: false, cancelled: false }],
    ["reschedule", { booked: false, rescheduled: true, cancelled: false }],
    ["cancel", { booked: false, rescheduled: false, cancelled: true }],
    ["confirm", { booked: false, rescheduled: false, cancelled: false }],
  ])("%s concluido limpa a task persistida", async (_label, outcome) => {
    loadConversation.mockResolvedValue(conversa("bot", activeTask));
    think.mockResolvedValueOnce({
      reply: "Operacao concluida.",
      handoff: false,
      ...outcome,
      agendaMutationCompleted: true,
      toolCalls: [],
    });

    await enviarPayload(payloadMensagem({ id: `wamid.${_label}` }));

    expect(setConversationTask).toHaveBeenCalledWith("est_odonto", PHONE, null);
  });

  it("regressao: confirmacao concluida limpa a task e o proximo ok fica silencioso", async () => {
    let persistedTask: ConversationTask | null = activeTask;
    const history: Message[] = [];
    loadConversation.mockImplementation(async () => conversa("bot", persistedTask ?? undefined, history));
    setConversationTask.mockImplementation(async (_estId, _conversationId, nextTask) => {
      persistedTask = nextTask as ConversationTask | null;
    });
    appendMessage.mockImplementation(async (_estId, _conversationId, role, text) => {
      history.push({ id: `m-${history.length}`, role, text, at: history.length + 1 });
      return { id: `m-${history.length}`, at: history.length };
    });
    think.mockResolvedValueOnce({
      reply: "Prontinho! Sua presenca esta confirmada.",
      handoff: false,
      booked: false,
      rescheduled: false,
      cancelled: false,
      agendaMutationCompleted: true,
      toolCalls: [{ name: "confirm_appointment", args: { appointmentId: "appt-1" } }],
    });

    await enviarPayload(payloadMensagem({ id: "wamid.confirm", text: "confirmo minha presenca" }));
    await enviarPayload(payloadMensagem({ id: "wamid.ok", text: "ok" }));

    expect(persistedTask).toBeNull();
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ok", "confirmed"],
    ["cancelar", "cancelled"],
  ])("atalho de lembrete (%s) limpa task depois de status %s", async (text, expectedStatus) => {
    loadConversation.mockResolvedValue(conversa("bot", activeTask));
    findNextAppointment.mockResolvedValueOnce({
      id: "appt-1",
      establishmentId: "est_odonto",
      contactPhone: PHONE,
      contactName: "Ana",
      serviceName: "Limpeza",
      startAt: Date.now() + 86_400_000,
      durationMin: 30,
      status: "pending",
      source: "bot",
      note: null,
      createdAt: 1,
      confirmedAt: null,
      reminderSentAt: 1,
    });

    await enviarPayload(payloadMensagem({ id: `wamid.reminder.${expectedStatus}`, text }));

    expect(setStatus).toHaveBeenCalledWith("est_odonto", "appt-1", expectedStatus);
    expect(setConversationTask).toHaveBeenCalledWith("est_odonto", PHONE, null);
    expect(think).not.toHaveBeenCalled();
  });

  it("falha real nao encerra a task ativa", async () => {
    loadConversation.mockResolvedValue(conversa("bot", activeTask));
    think.mockResolvedValueOnce({
      reply: "Nao consegui concluir agora.",
      handoff: false,
      booked: false,
      rescheduled: false,
      cancelled: false,
      agendaMutationCompleted: false,
      toolCalls: [{ name: "confirm_appointment", args: { appointmentId: "appt-1" } }],
    });

    await enviarPayload(payloadMensagem({ id: "wamid.failed" }));

    expect(setConversationTask).toHaveBeenCalledWith(
      "est_odonto",
      PHONE,
      expect.objectContaining({ state: "confirm" }),
    );
  });

  it("mutacao concluida limpa a task mesmo se o envio da resposta falhar", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConversation.mockResolvedValue(conversa("bot", activeTask));
    think.mockResolvedValueOnce({
      reply: "Prontinho! Sua presenca esta confirmada.",
      handoff: false,
      booked: false,
      rescheduled: false,
      cancelled: false,
      agendaMutationCompleted: true,
      toolCalls: [{ name: "confirm_appointment", args: { appointmentId: "appt-1" } }],
    });
    sendText.mockRejectedValueOnce(new Error("falha controlada"));

    const response = await enviarPayload(payloadMensagem({ id: "wamid.send-failed", text: "confirmo" }));

    expect(response.status).toBe(200);
    expect(setConversationTask).toHaveBeenCalledWith("est_odonto", PHONE, null);
    consoleError.mockRestore();
  });

  it("assunto novo depois da conclusao nao reativa a task antiga", async () => {
    let persistedTask: ConversationTask | null = activeTask;
    loadConversation.mockImplementation(async () => conversa("bot", persistedTask ?? undefined));
    setConversationTask.mockImplementation(async (_estId, _conversationId, nextTask) => {
      persistedTask = nextTask as ConversationTask | null;
    });
    think
      .mockResolvedValueOnce({
        reply: "Prontinho! Seu horario foi remarcado.",
        handoff: false,
        booked: false,
        rescheduled: true,
        cancelled: false,
        agendaMutationCompleted: true,
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        reply: "Ficamos no centro.",
        handoff: false,
        booked: false,
        rescheduled: false,
        cancelled: false,
        agendaMutationCompleted: false,
        toolCalls: [],
      });

    await enviarPayload(payloadMensagem({ id: "wamid.rescheduled", text: "pode remarcar" }));
    await enviarPayload(payloadMensagem({ id: "wamid.address", text: "qual e o endereco?" }));

    expect(persistedTask).toBeNull();
    expect(think).toHaveBeenCalledTimes(2);
  });

  it("ok durante task realmente ativa continua chegando a IA", async () => {
    loadConversation.mockResolvedValue(conversa("bot", activeTask));

    await enviarPayload(payloadMensagem({ id: "wamid.active-ok", text: "ok" }));

    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(setConversationTask).toHaveBeenCalledWith(
      "est_odonto",
      PHONE,
      expect.objectContaining({ state: "confirm" }),
    );
  });
});

describe("1 — mensagem de texto recebida", () => {
  it("percorre o caminho inteiro: IA chamada, resposta enviada e persistida", async () => {
    const res = await enviarPayload(payloadMensagem());

    expect(res.status).toBe(200);
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[3]).toBe("Claro! Posso te ajudar com isso.");
    expect(appendMessage).toHaveBeenCalledWith("est_odonto", PHONE, "bot", "Claro! Posso te ajudar com isso.", "wamid.bot");
  });
});

describe("1b — credenciais de App Review", () => {
  const testPhoneNumberId = "test-phone-number-id";
  const testEstablishmentId = "test-establishment-id";

  function configurarCredenciaisDeTeste(environment: "production" | "preview") {
    vi.stubEnv("VERCEL_ENV", environment);
    vi.stubEnv("WHATSAPP_TEST_PHONE_NUMBER_ID", testPhoneNumberId);
    vi.stubEnv("WHATSAPP_TEST_ESTABLISHMENT_ID", testEstablishmentId);
    vi.stubEnv("WHATSAPP_TEST_ACCESS_TOKEN", "test-access-token");
  }

  it("em Production não aceita o bypass nem para o phoneNumberId de teste", async () => {
    configurarCredenciaisDeTeste("production");
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());

    await enviarPayload({
      entry: [{ changes: [{ value: { ...payloadMensagem().entry[0].changes[0].value, metadata: { phone_number_id: testPhoneNumberId } } }] }],
    });

    expect(getEstablishment).not.toHaveBeenCalled();
    expect(findEstablishmentByPhoneNumberId).toHaveBeenCalledWith(testPhoneNumberId);
  });

  it("em Preview mantém o bypass somente para o estabelecimento configurado", async () => {
    configurarCredenciaisDeTeste("preview");
    getEstablishment.mockResolvedValue(establishment({ id: testEstablishmentId }));

    await enviarPayload({
      entry: [{ changes: [{ value: { ...payloadMensagem().entry[0].changes[0].value, metadata: { phone_number_id: testPhoneNumberId } } }] }],
    });

    expect(getEstablishment).toHaveBeenCalledWith(testEstablishmentId);
    expect(findEstablishmentByPhoneNumberId).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("2 — mensagem sem texto (áudio/imagem/sem corpo)", () => {
  function payloadAudio(id = "wamid.1") {
    const audio = payloadMensagem({ type: "audio", omitText: true });
    const msg = audio.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    msg.id = id;
    msg.audio = { id: "media.audio", mime_type: "audio/ogg", sha256: "hash", file_size: 3, voice: true };
    return audio;
  }

  it("áudio válido é transcrito e entra no mesmo pipeline textual", async () => {
    const res = await enviarPayload(payloadAudio());

    expect(res.status).toBe(200);
    expect(downloadWhatsAppAudio).toHaveBeenCalledWith(expect.anything(), "est_odonto", "media.audio");
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(think).toHaveBeenCalledWith(expect.objectContaining({
      history: expect.arrayContaining([expect.objectContaining({ text: "Quero marcar uma avaliação amanhã às dez" })]),
    }));
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith("est_odonto", PHONE, "customer", "Quero marcar uma avaliação amanhã às dez", "wamid.1", {
      kind: "audio",
      phoneNumberId: "pn_1",
      media: { metaMediaId: "media.audio", mimeType: "audio/ogg", sha256: "hash", fileSizeBytes: 3, voice: true },
      transcription: expect.objectContaining({
        status: "completed",
        text: "Quero marcar uma avaliação amanhã às dez",
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
      }),
    });
  });

  it("áudio com voz habilitada sintetiza a resposta final uma vez e envia mídia", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ bot: { personaName: "Livia", tone: "", bookingEnabled: true, medicalGuardrail: false, handoffKeywords: [], voiceRepliesEnabled: true } }));
    const res = await enviarPayload(payloadAudio("wamid.voice"));
    expect(res.status).toBe(200); expect(think).toHaveBeenCalledTimes(1); expect(synthesizeSpeech).toHaveBeenCalledWith("Claro! Posso te ajudar com isso.");
    expect(sendAudio).toHaveBeenCalledWith(expect.anything(), "est_odonto", PHONE, new Uint8Array([1, 2]), "audio/ogg"); expect(sendText).not.toHaveBeenCalled();
  });

  it("falha de TTS preserva a resposta textual sem reexecutar IA", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ bot: { personaName: "Livia", tone: "", bookingEnabled: true, medicalGuardrail: false, handoffKeywords: [], voiceRepliesEnabled: true } }));
    synthesizeSpeech.mockRejectedValueOnce(new Error("provider down"));
    await enviarPayload(payloadAudio("wamid.voice.fallback"));
    expect(think).toHaveBeenCalledTimes(1); expect(sendAudio).not.toHaveBeenCalled(); expect(sendText).toHaveBeenCalledWith(expect.anything(), "est_odonto", PHONE, "Claro! Posso te ajudar com isso.");
  });

  it("rejeição explícita de envio de áudio cai em texto sem repetir IA", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ bot: { personaName: "Livia", tone: "", bookingEnabled: true, medicalGuardrail: false, handoffKeywords: [], voiceRepliesEnabled: true } }));
    sendAudio.mockRejectedValueOnce(new WhatsAppAudioSendError("audio_send_failed", true, 500));
    await enviarPayload(payloadAudio("wamid.voice.upload"));
    expect(think).toHaveBeenCalledTimes(1); expect(synthesizeSpeech).toHaveBeenCalledTimes(1); expect(sendText).toHaveBeenCalledWith(expect.anything(), "est_odonto", PHONE, "Claro! Posso te ajudar com isso.");
  });

  it("resultado ambíguo após POST de áudio não envia texto nem repete o processamento", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ bot: { personaName: "Livia", tone: "", bookingEnabled: true, medicalGuardrail: false, handoffKeywords: [], voiceRepliesEnabled: true } }));
    sendAudio.mockRejectedValueOnce(new WhatsAppAudioSendError("audio_send_ambiguous", false));
    await enviarPayload(payloadAudio("wamid.voice.ambiguous"));
    expect(think).toHaveBeenCalledTimes(1); expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(sendAudio).toHaveBeenCalledTimes(1); expect(sendText).not.toHaveBeenCalled();
  });

  it("resposta determinística de handoff também usa voz para inbound áudio", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ bot: { personaName: "Livia", tone: "", bookingEnabled: true, medicalGuardrail: false, handoffKeywords: [], voiceRepliesEnabled: true } }));
    loadConversation.mockResolvedValue(conversa("bot", undefined, [], { awaitingHumanOfferConfirmation: true }));
    transcribeAudio.mockResolvedValueOnce({ text: "sim", provider: "openai", model: "gpt-4o-mini-transcribe" });
    await enviarPayload(payloadAudio("wamid.voice.handoff"));
    expect(think).not.toHaveBeenCalled(); expect(synthesizeSpeech).toHaveBeenCalledWith("Certo! Vou chamar uma pessoa da equipe para te ajudar por aqui.");
    expect(sendAudio).toHaveBeenCalledTimes(1); expect(sendText).not.toHaveBeenCalled();
  });

  it("transcript de agenda preserva o contrato de agenda e CRM", async () => {
    detectIntent.mockReturnValue({ type: "schedule_appointment", confidence: 0.9, entities: {} } as never);
    think.mockResolvedValueOnce({
      reply: "Agendado.", handoff: false, booked: true, rescheduled: false, cancelled: false,
      agendaMutationCompleted: true,
      toolCalls: [{ name: "create_appointment", args: { serviceName: "Avaliação" } }],
      pendingCancelAppointmentId: null, statedDate: "2026-09-18", statedService: "Avaliação",
    });

    await enviarPayload(payloadAudio("wamid.audio.agenda"));

    expect(setConversationTask).toHaveBeenCalledWith("est_odonto", PHONE, null);
    expect(setConversationIntent).toHaveBeenCalledWith("est_odonto", PHONE, "schedule_appointment");
    expect(upsertCustomerProfile).toHaveBeenCalledWith("est_odonto", PHONE, expect.objectContaining({
      lastIntent: "schedule_appointment",
      lastService: "Avaliação",
    }));
  });

  it("transcript de handoff segue o fluxo textual existente", async () => {
    transcribeAudio.mockResolvedValueOnce({ text: "Quero falar com uma pessoa", provider: "openai", model: "gpt-4o-mini-transcribe" });
    detectIntent.mockReturnValue({ type: "request_human", confidence: 0.99, entities: {} } as never);
    think.mockResolvedValueOnce({
      reply: "Vou chamar uma pessoa.", handoff: true, booked: false, rescheduled: false, cancelled: false,
      agendaMutationCompleted: false, toolCalls: [], pendingCancelAppointmentId: null, statedDate: null, statedService: null,
    });

    await enviarPayload(payloadAudio("wamid.audio.handoff"));

    expect(setConversationStatus).toHaveBeenCalledWith("est_odonto", PHONE, "handoff");
    expect(think).toHaveBeenCalledWith(expect.objectContaining({
      history: expect.arrayContaining([expect.objectContaining({ text: "Quero falar com uma pessoa" })]),
    }));
  });

  it("áudio passivo transcrito obedece à mesma regra de silêncio", async () => {
    transcribeAudio.mockResolvedValueOnce({ text: "ok", provider: "openai", model: "gpt-4o-mini-transcribe" });
    loadConversation.mockResolvedValueOnce(conversa("bot", undefined, [
      { id: "bot-1", role: "bot", text: "Seu horário foi confirmado para amanhã às 10h.", at: 1 },
    ]));

    await enviarPayload(payloadAudio("wamid.audio.ok"));

    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("falha de transcrição persiste estado seguro, não chama IA e responde naturalmente", async () => {
    transcribeAudio.mockRejectedValueOnce(new Error("provider secret detail"));

    await enviarPayload(payloadAudio("wamid.audio.fail"));

    expect(think).not.toHaveBeenCalled();
    expect(appendMessage).toHaveBeenCalledWith("est_odonto", PHONE, "customer", "[Áudio recebido]", "wamid.audio.fail", expect.objectContaining({
      kind: "audio",
      transcription: expect.objectContaining({ status: "failed", errorCode: "unexpected_error" }),
    }));
    expect(sendText.mock.calls[0]?.[3]).toMatch(/não consegui entender esse áudio/i);
  });

  it.each(["human", "handoff"])("falha de áudio em %s preserva silêncio e fila humana", async (status) => {
    loadConversation.mockResolvedValueOnce(conversa(status as "human" | "handoff"));
    transcribeAudio.mockRejectedValueOnce(new Error("provider failure"));

    await enviarPayload(payloadAudio(`wamid.audio.fail.${status}`));

    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(upsertPendingTask).toHaveBeenCalledWith("est_odonto", PHONE, PHONE, {
      type: "awaiting_human",
      waitingFor: "responder mensagem nova do cliente",
    });
  });

  it("media_id ausente não baixa, não transcreve e usa o fallback", async () => {
    const audio = payloadAudio("wamid.audio.no-id");
    (audio.entry[0].changes[0].value.messages[0] as Record<string, unknown>).audio = { mime_type: "audio/ogg" };

    await enviarPayload(audio);

    expect(downloadWhatsAppAudio).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(think).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0]?.[3]).toMatch(/não consegui entender esse áudio/i);
  });

  it("reentrega concorrente do mesmo áudio transcreve e responde uma vez", async () => {
    alreadyProcessed.mockImplementation(async () => alreadyProcessed.mock.calls.length > 1);
    let release!: () => void;
    transcribeAudio.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ text: "Olá", provider: "openai", model: "gpt-4o-mini-transcribe" });
    }));
    const payload = payloadAudio("wamid.audio.concurrent");

    const first = enviarPayload(payload);
    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1));
    const second = enviarPayload(payload);
    await vi.waitFor(() => expect(alreadyProcessed).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);

    expect(downloadWhatsAppAudio).toHaveBeenCalledTimes(1);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("imagem é baixada, armazenada e associada à mensagem sem chegar à IA", async () => {
    const payload = payloadMensagem({ type: "image", omitText: true, id: "wamid.image" });
    const msg = payload.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    msg.image = { id: "media.image", mime_type: "image/jpeg", caption: "Olha como ficou" };

    await enviarPayload(payload);

    expect(downloadWhatsAppMedia).toHaveBeenCalledWith(expect.anything(), "est_odonto", "media.image", "image");
    expect(storeConversationAttachment).toHaveBeenCalledWith(expect.objectContaining({
      establishmentId: "est_odonto", conversationId: PHONE, waMessageId: "wamid.image",
      metaMediaId: "media.image", type: "image", mimeType: "image/jpeg",
    }));
    expect(appendMessage).toHaveBeenCalledWith("est_odonto", PHONE, "customer", "Olha como ficou", "wamid.image", expect.objectContaining({
      kind: "image",
      attachment: expect.objectContaining({ type: "image", storageRef: expect.stringContaining("/est_odonto/") }),
    }));
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("PDF preserva filename e metadata na mensagem sem chegar à IA", async () => {
    downloadWhatsAppMedia.mockResolvedValueOnce({ bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf", sizeBytes: 3 });
    const payload = payloadMensagem({ type: "document", omitText: true, id: "wamid.document" });
    const msg = payload.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    msg.document = { id: "media.document", mime_type: "application/pdf", filename: "laudo.pdf" };

    await enviarPayload(payload);

    expect(storeConversationAttachment).toHaveBeenCalledWith(expect.objectContaining({
      type: "document", filename: "laudo.pdf", mimeType: "application/pdf",
    }));
    expect(appendMessage).toHaveBeenCalledWith("est_odonto", PHONE, "customer", "[Documento recebido]", "wamid.document", expect.objectContaining({
      media: expect.objectContaining({ filename: "laudo.pdf", storageRef: expect.any(String) }),
      attachment: expect.objectContaining({ type: "document", filename: "laudo.pdf" }),
    }));
    expect(think).not.toHaveBeenCalled();
  });

  it("falha de download mantém a mensagem, sem storage, IA ou resposta", async () => {
    downloadWhatsAppMedia.mockRejectedValueOnce(new Error("Meta indisponível"));
    const payload = payloadMensagem({ type: "image", omitText: true, id: "wamid.image.fail" });
    (payload.entry[0].changes[0].value.messages[0] as Record<string, unknown>).image = { id: "media.image", mime_type: "image/jpeg" };

    await enviarPayload(payload);

    expect(storeConversationAttachment).not.toHaveBeenCalled();
    expect(appendMessage).toHaveBeenCalledWith("est_odonto", PHONE, "customer", "[Imagem recebida]", "wamid.image.fail", expect.not.objectContaining({ attachment: expect.anything() }));
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("falha de storage mantém a mensagem sem referência quebrada", async () => {
    storeConversationAttachment.mockRejectedValueOnce(new Error("bucket unavailable"));
    const payload = payloadMensagem({ type: "document", omitText: true, id: "wamid.document.fail" });
    (payload.entry[0].changes[0].value.messages[0] as Record<string, unknown>).document = {
      id: "media.document", mime_type: "application/pdf", filename: "laudo.pdf",
    };

    await enviarPayload(payload);

    expect(appendMessage).toHaveBeenCalledWith("est_odonto", PHONE, "customer", "[Documento recebido]", "wamid.document.fail", expect.not.objectContaining({ attachment: expect.anything() }));
    expect(think).not.toHaveBeenCalled();
  });

  it("falha ao associar mensagem remove o objeto e não mantém storageRef órfão", async () => {
    appendMessage.mockRejectedValueOnce(new Error("Firestore indisponível")).mockResolvedValueOnce({ id: "msg-fallback", at: 1 });
    const payload = payloadMensagem({ type: "image", omitText: true, id: "wamid.image.partial" });
    (payload.entry[0].changes[0].value.messages[0] as Record<string, unknown>).image = {
      id: "media.image", mime_type: "image/jpeg",
    };

    await enviarPayload(payload);

    expect(deleteConversationAttachment).toHaveBeenCalledWith(
      "est_odonto", PHONE, expect.stringContaining("/attachments/"),
    );
    expect(appendMessage).toHaveBeenCalledTimes(2);
    expect(appendMessage.mock.calls[1]?.[5]).not.toHaveProperty("attachment");
    expect(appendMessage.mock.calls[1]?.[5]?.media).not.toHaveProperty("storageRef");
  });

  it("unsupported continua reconhecido sem download ou interpretação", async () => {
    await enviarPayload(payloadMensagem({ type: "unsupported", omitText: true, id: "wamid.unsupported" }));
    expect(downloadWhatsAppMedia).not.toHaveBeenCalled();
    expect(storeConversationAttachment).not.toHaveBeenCalled();
    expect(think).not.toHaveBeenCalled();
  });

  it("logs não incluem transcript completo, binário ou token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    transcribeAudio.mockResolvedValueOnce({ text: "frase-secreta-do-cliente", provider: "openai", model: "gpt-4o-mini-transcribe" });

    await enviarPayload(payloadAudio("wamid.audio.logs"));

    const output = log.mock.calls.flat().join(" ");
    expect(output).not.toContain("frase-secreta-do-cliente");
    expect(output).not.toContain("server-secret-token");
    expect(output).not.toContain("1,2,3");
    log.mockRestore();
  });

  it("type=text mas sem corpo: mesmo tratamento, sem chamar a IA", async () => {
    const res = await enviarPayload(payloadMensagem({ type: "text", omitText: true }));

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
  });
});

describe("3 — status update (sem messages[])", () => {
  it("evento de entrega/leitura: 200, nada é processado, ninguém quebra", async () => {
    const res = await enviarPayload({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pn_1" },
                statuses: [{ id: "wamid.1", status: "delivered" }],
              },
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });
});

describe("3b — eventos de sincronização Coexistence", () => {
  for (const field of ["smb_message_echoes", "history", "smb_app_state_sync"]) {
    it(`${field}: responde 200 sem atingir processMessage, IA ou envio`, async () => {
      const res = await enviarPayload({
        entry: [
          {
            changes: [
              {
                field,
                value: {
                  metadata: { phone_number_id: "pn_1" },
                  messages: [{ id: `wamid.${field}`, from: PHONE, type: "text", text: { body: "evento espelhado" } }],
                },
              },
            ],
          },
        ],
      });

      expect(res.status).toBe(200);
      expect(alreadyProcessed).not.toHaveBeenCalled();
      expect(findEstablishmentByPhoneNumberId).not.toHaveBeenCalled();
      expect(think).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
    });
  }
});

describe("4 — evento desconhecido / payload vazio", () => {
  it("entry vazio: 200, sem exceção, sem processar nada", async () => {
    const res = await enviarPayload({ entry: [] });

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
  });

  it("payload sem a forma esperada: 200, sem exceção", async () => {
    const res = await enviarPayload({ object: "whatsapp_business_account", entry: [{ changes: [{}] }] });

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
  });
});

describe("5 — mensagem duplicada (reentrega da Meta)", () => {
  it("segunda entrega do mesmo message id: IA chamada só uma vez", async () => {
    alreadyProcessed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const payload = payloadMensagem({ id: "wamid.dup" });
    await enviarPayload(payload);
    await enviarPayload(payload);

    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("reentrega de áudio pelo mesmo wamid não grava nem transcreve duas vezes", async () => {
    alreadyProcessed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const audio = payloadMensagem({ type: "audio", omitText: true, id: "wamid.audio.dup" });
    const msg = audio.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    msg.audio = { id: "media.audio" };
    await enviarPayload(audio);
    await enviarPayload(audio);

    expect(appendMessage.mock.calls.filter((c) => c[2] === "customer")).toHaveLength(1);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("reentrega de imagem pelo mesmo wamid não baixa, armazena ou grava duas vezes", async () => {
    alreadyProcessed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const payload = payloadMensagem({ type: "image", omitText: true, id: "wamid.image.dup" });
    (payload.entry[0].changes[0].value.messages[0] as Record<string, unknown>).image = {
      id: "media.image", mime_type: "image/jpeg",
    };

    await enviarPayload(payload);
    await enviarPayload(payload);

    expect(downloadWhatsAppMedia).toHaveBeenCalledTimes(1);
    expect(storeConversationAttachment).toHaveBeenCalledTimes(1);
    expect(appendMessage.mock.calls.filter((c) => c[2] === "customer")).toHaveLength(1);
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("6 — erro da IA", () => {
  it("think() lança: nenhuma resposta falsa é enviada, e o erro não é engolido em silêncio", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    think.mockRejectedValueOnce(new Error("OpenAI indisponível"));

    const res = await enviarPayload(payloadMensagem());

    // Contrato com a Meta continua o mesmo (sempre 200, para não desativar o
    // webhook) — mas sendText nunca roda, então o cliente não recebe nada
    // fabricado, e o erro aparece no log em vez de sumir.
    expect(res.status).toBe(200);
    expect(sendText).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalledWith("est_odonto", PHONE, "bot", expect.anything(), expect.anything());
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("7 — erro da API do WhatsApp", () => {
  it("sendText() lança: a resposta gerada não é persistida como enviada, erro não é silencioso", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    sendText.mockRejectedValueOnce(new Error("WhatsApp sendText 401: token inválido"));

    const res = await enviarPayload(payloadMensagem());

    expect(res.status).toBe(200);
    expect(think).toHaveBeenCalledTimes(1);
    // appendMessage só é chamado para o "bot" DEPOIS de sendText suceder —
    // se sendText falhou, não existe registro de uma mensagem que nunca saiu.
    expect(appendMessage).not.toHaveBeenCalledWith("est_odonto", PHONE, "bot", expect.anything(), expect.anything());
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("assinatura ausente/errada — não processa nada, mas não derruba o webhook", () => {
  it("sem header de assinatura: 200, nada chamado", async () => {
    const json = JSON.stringify(payloadMensagem());
    const req = new Request("https://livia.test/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
  });

  it("assinatura de outro corpo (não bate): 200, nada chamado", async () => {
    const json = JSON.stringify(payloadMensagem());
    const req = new Request("https://livia.test/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": assinar("{}") },
      body: json,
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
  });
});

describe("múltiplas mensagens no mesmo POST (batch da Meta)", () => {
  it("duas mensagens no mesmo entry/change: ambas são processadas, não só a primeira", async () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pn_1" },
                contacts: [{ profile: { name: "Ana" } }],
                messages: [
                  { id: "wamid.a", from: PHONE, type: "text", text: { body: "oi" } },
                  { id: "wamid.b", from: PHONE, type: "text", text: { body: "cancela esse" } },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await enviarPayload(body);

    expect(res.status).toBe(200);
    expect(think).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("falha em uma mensagem não impede o texto seguinte do lote", async () => {
    loadConversation.mockRejectedValueOnce(new Error("falha isolada")).mockResolvedValueOnce(conversa("bot"));
    const body = {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "pn_1" },
        contacts: [{ profile: { name: "Ana" } }],
        messages: [
          { id: "wamid.fail", from: PHONE, type: "text", text: { body: "primeira" } },
          { id: "wamid.ok", from: PHONE, type: "text", text: { body: "segunda" } },
        ],
      } }] }],
    };

    const res = await enviarPayload(body);

    expect(res.status).toBe(200);
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("mídia durante atendimento humano é anexada sem resposta da Lívia", async () => {
    loadConversation.mockResolvedValue(conversa("human"));
    const image = payloadMensagem({ type: "image", omitText: true });
    const msg = image.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    msg.image = { id: "media.image" };

    const res = await enviarPayload(image);

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(upsertPendingTask).not.toHaveBeenCalled();
    expect(appendMessage).toHaveBeenCalledWith(
      "est_odonto", PHONE, "customer", "[Imagem recebida]", "wamid.1",
      expect.objectContaining({
        kind: "image",
        phoneNumberId: "pn_1",
        media: expect.objectContaining({ metaMediaId: "media.image", storageRef: expect.any(String) }),
        attachment: expect.objectContaining({ type: "image" }),
      }),
    );
  });
});
