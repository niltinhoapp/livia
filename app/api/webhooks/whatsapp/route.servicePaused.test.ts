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

describe("CRÍTICO 5 — conta inativa não pode virar silêncio", () => {
  it("(1) estabelecimento ativo: fluxo normal, IA responde", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
    loadConversation.mockResolvedValue(conversa("bot"));

    await entregar("bom dia");

    expect(think).toHaveBeenCalledTimes(1);
    expect(textosEnviados()).toEqual(["Claro! Posso te ajudar com isso."]);
  });

  it("(2) estabelecimento suspenso: não chama a IA, não roda ferramenta, mas responde", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ status: "suspended" }));
    loadConversation.mockResolvedValue(conversa("bot"));

    await entregar("bom dia");

    expect(think).not.toHaveBeenCalled();
    expect(textosEnviados()).toEqual([SERVICE_PAUSED_REPLY]);
  });

  it("(2b) a mensagem do cliente é registrada mesmo com a conta suspensa", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ status: "suspended" }));
    loadConversation.mockResolvedValue(conversa("bot"));

    await entregar("tem alguém?");

    const doCliente = appendMessage.mock.calls.find((c) => c[2] === "customer");
    expect(doCliente?.[3]).toBe("tem alguém?");
  });

  it("(3) o cliente NUNCA vê trial, cobrança, pagamento, assinatura ou plano", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ status: "suspended" }));
    loadConversation.mockResolvedValue(conversa("bot"));

    await entregar("oi");

    const texto = textosEnviados().join(" ").toLowerCase();
    for (const proibido of ["trial", "assinatura", "cobran", "pagamento", "plano", "vencid", "expirad", "suspens", "livia", "saas"]) {
      expect(texto).not.toContain(proibido);
    }
  });

  it("(4) WhatsApp desconectado não é confundido com conta inativa", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(
      establishment({ whatsapp: { wabaId: "w", phoneNumberId: "pn_1", status: "disconnected" } as never }),
    );
    loadConversation.mockResolvedValue(conversa("bot"));

    await entregar("oi");

    // Sem canal conectado não existe caminho de resposta: nada é enviado, e
    // nada é classificado como problema comercial.
    expect(sendText).not.toHaveBeenCalled();
    expect(think).not.toHaveBeenCalled();
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it("(5) erro técnico não vira 'conta inativa': nenhuma resposta de pausa é enviada", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
    loadConversation.mockResolvedValue(conversa("bot"));
    think.mockRejectedValue(new Error("OpenAI 500"));

    const res = await entregar("oi");

    expect(await res.json()).toEqual({ received: true }); // 200 pra Meta não reenviar
    expect(textosEnviados()).not.toContain(SERVICE_PAUSED_REPLY);
  });

  it("(6) anti-spam: 4 mensagens seguidas geram UMA resposta só", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ status: "suspended" }));

    // 1ª mensagem: histórico ainda sem aviso.
    loadConversation.mockResolvedValueOnce(conversa("bot", []));
    await entregar("oi", "wamid.1");

    // As seguintes já enxergam o aviso recém-enviado no histórico.
    const comAviso = [botMessage(SERVICE_PAUSED_REPLY, Date.now())];
    loadConversation.mockResolvedValue(conversa("bot", comAviso));
    await entregar("tem alguém?", "wamid.2");
    await entregar("oi??", "wamid.3");
    await entregar("bom dia", "wamid.4");

    expect(textosEnviados()).toEqual([SERVICE_PAUSED_REPLY]);
    // As 4 mensagens do cliente continuam registradas.
    expect(appendMessage.mock.calls.filter((c) => c[2] === "customer")).toHaveLength(4);
  });

  it("(6b) passado o cooldown, o aviso volta a ser enviado", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ status: "suspended" }));
    const antigo = [botMessage(SERVICE_PAUSED_REPLY, Date.now() - 2 * 60 * 60 * 1000)];
    loadConversation.mockResolvedValue(conversa("bot", antigo));

    await entregar("oi de novo");

    expect(textosEnviados()).toEqual([SERVICE_PAUSED_REPLY]);
  });

  it("(7) isolamento: a decisão usa o estabelecimento resolvido pelo phone_number_id", async () => {
    findEstablishmentByPhoneNumberId.mockResolvedValue(establishment({ id: "est_pet", status: "suspended" }));
    loadConversation.mockResolvedValue(conversa("bot"));

    await entregar("oi");

    expect(loadConversation.mock.calls[0]![0]).toBe("est_pet");
    expect(appendMessage.mock.calls.every((c) => c[0] === "est_pet")).toBe(true);
    expect((sendText.mock.calls[0] as unknown[])[1]).toBe("est_pet");
  });
});

