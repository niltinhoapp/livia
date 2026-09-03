// Orquestração do webhook do WhatsApp.
//
// Não testa funções isoladas: monta um POST assinado igual ao da Meta e prova
// o que o SISTEMA faz — quem é chamado, o que é persistido, o que o cliente
// recebe e o que ele NUNCA pode receber.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Establishment, Message } from "@/types";

const APP_SECRET = "segredo-de-teste";
process.env.META_APP_SECRET = APP_SECRET;

// ---- dublês ----
const findEstablishmentByPhoneNumberId = vi.fn();
const loadConversation = vi.fn();
const appendMessage = vi.fn();
const setConversationStatus = vi.fn();
const upsertPendingTask = vi.fn();
const resolvePendingTask = vi.fn();
const alreadyProcessed = vi.fn(async (_id: string) => false);
const think = vi.fn();
const sendText = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.bot" }));
const markAsRead = vi.fn();
const findNextAppointment = vi.fn(async (..._a: unknown[]) => null);

vi.mock("@/lib/repo", () => ({
  findEstablishmentByPhoneNumberId: (...a: unknown[]) => findEstablishmentByPhoneNumberId(...a),
  getEstablishment: vi.fn(async () => null),
  getKnowledgeBase: vi.fn(async () => null),
  loadConversation: (...a: unknown[]) => loadConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  setConversationStatus: (...a: unknown[]) => setConversationStatus(...a),
  setConversationIntent: vi.fn(),
  setConversationTask: vi.fn(),
  setConversationSummary: vi.fn(),
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(),
  upsertPendingTask: (...a: unknown[]) => upsertPendingTask(...a),
  resolvePendingTask: (...a: unknown[]) => resolvePendingTask(...a),
  alreadyProcessed: (...a: unknown[]) => alreadyProcessed(...(a as [string])),
}));

vi.mock("@/lib/whatsapp/client", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  markAsRead: (...a: unknown[]) => markAsRead(...a),
  normalizePhone: (raw: string) => raw.replace(/\D/g, ""),
}));

vi.mock("@/lib/ai/brain", () => ({ think: (...a: unknown[]) => think(...a) }));
vi.mock("@/lib/ai/intent", () => ({ detectIntent: () => ({ type: "other" }) }));
vi.mock("@/lib/ai/taskState", () => ({ deriveTaskState: () => null }));
vi.mock("@/lib/ai/pendingTask", () => ({ derivePendingTask: () => null }));
vi.mock("@/lib/ai/summarize", () => ({ summarizeConversation: vi.fn(async () => null) }));
vi.mock("@/lib/scheduling", () => ({
  findNextAppointment: (...a: unknown[]) => findNextAppointment(...a),
  setStatus: vi.fn(),
}));

const { POST } = await import("@/app/api/webhooks/whatsapp/route");
const { SERVICE_PAUSED_REPLY } = await import("@/lib/servicePaused");

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

function conversa(status: "bot" | "handoff" | "human" | "closed", history: Message[] = []) {
  return {
    conversation: { id: PHONE, establishmentId: "est_odonto", contactPhone: PHONE, contactName: "Ana", status, lastMessageAt: 0, createdAt: 0 },
    history,
  };
}

function botMessage(text: string, at: number): Message {
  return { id: `m_${at}`, role: "bot", text, at };
}

async function entregar(texto: string, msgId = `wamid.${Math.random()}`) {
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "pn_1" },
              contacts: [{ profile: { name: "Ana" } }],
              messages: [{ id: msgId, from: PHONE, type: "text", text: { body: texto } }],
            },
          },
        ],
      },
    ],
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

beforeEach(() => {
  vi.clearAllMocks();
  alreadyProcessed.mockResolvedValue(false);
  sendText.mockResolvedValue({ waMessageId: "wamid.bot" });
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

describe("CRÍTICO 4 — handoff não pode virar beco sem saída", () => {
  it("(1)(2)(3) cliente pede humano: status vira handoff e a IA para", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
    loadConversation.mockResolvedValue(conversa("bot"));
    think.mockResolvedValue({
      reply: "Vou chamar uma pessoa da equipe pra te ajudar.",
      handoff: true,
      booked: false,
      rescheduled: false,
      cancelled: false,
      toolCalls: [],
    });

    await entregar("quero falar com uma pessoa");

    expect(setConversationStatus).toHaveBeenCalledWith("est_odonto", PHONE, "handoff");
  });

  it("(4)(5)(6) mensagem nova durante handoff: fica salva, IA não responde", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
    loadConversation.mockResolvedValue(conversa("handoff"));

    await entregar("alô, ainda estou aqui");

    const doCliente = appendMessage.mock.calls.find((c) => c[2] === "customer");
    expect(doCliente?.[3]).toBe("alô, ainda estou aqui");
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("(7) mensagem nova durante handoff reabre a pendência — a conversa volta a pedir atenção", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
    loadConversation.mockResolvedValue(conversa("handoff"));

    await entregar("alguém?");

    expect(upsertPendingTask).toHaveBeenCalledTimes(1);
    const [estId, convId, phone, draft] = upsertPendingTask.mock.calls[0] as [string, string, string, { type: string }];
    expect(estId).toBe("est_odonto");
    expect(convId).toBe(PHONE);
    expect(phone).toBe(PHONE);
    expect(draft.type).toBe("awaiting_human");
  });

  it("(8)(9) humano assumiu (status human): mensagem nova NÃO some e volta a marcar pendência", async () => {
    // Este era o buraco: PATCH assume resolve a pendência, a conversa vira
    // "human" e a caixa de entrada passava a mostrar "Sem pendência"
    // enquanto o cliente continuava escrevendo.
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
    loadConversation.mockResolvedValue(conversa("human"));

    await entregar("consegue ver minha mensagem?");

    expect(appendMessage).toHaveBeenCalled();
    expect(think).not.toHaveBeenCalled();
    expect(upsertPendingTask).toHaveBeenCalledTimes(1);
    expect((upsertPendingTask.mock.calls[0] as unknown[])[3]).toMatchObject({ type: "awaiting_human" });
  });

  it("(10) não existe retomada automática: a Livia nunca volta a responder sozinha durante handoff", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
    loadConversation.mockResolvedValue(conversa("human"));

    for (const t of ["oi", "oi?", "por favor", "alguém aí"]) await entregar(t, `wamid.${t}`);

    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(setConversationStatus).not.toHaveBeenCalled();
  });

  it("(11) isolamento: a pendência é gravada no tenant resolvido, nunca em outro", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ id: "est_pet" }));
    loadConversation.mockResolvedValue(conversa("handoff"));

    await entregar("oi");

    expect((upsertPendingTask.mock.calls[0] as unknown[])[0]).toBe("est_pet");
  });

  it("conta suspensa vence handoff: nem a IA nem a pendência de humano entram em cena", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ status: "suspended" }));
    loadConversation.mockResolvedValue(conversa("handoff"));

    await entregar("oi");

    expect(think).not.toHaveBeenCalled();
    expect(textosEnviados()).toEqual([SERVICE_PAUSED_REPLY]);
  });
});
