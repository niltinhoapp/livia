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
import type { ConversationTask, Establishment, Message } from "@/types";

const APP_SECRET = "segredo-de-teste";
process.env.META_APP_SECRET = APP_SECRET;

// ---- dublês ----
const findEstablishmentByPhoneNumberId = vi.fn();
const getEstablishment = vi.fn();
const loadConversation = vi.fn();
const appendMessage = vi.fn();
const setConversationTask = vi.fn();
const upsertPendingTask = vi.fn();
const resolvePendingTask = vi.fn();
const alreadyProcessed = vi.fn(async (_id: string) => false);
const closeConversation = vi.fn();
const tryCloseAutomatedConversation = vi.fn(async (..._a: unknown[]) => true);
const reopenConversation = vi.fn(async (..._a: unknown[]) => undefined);
const getPendingTask = vi.fn(
  async (..._a: unknown[]): Promise<{ status: "open" | "resolved" } | null> => null,
);
const think = vi.fn();
const sendText = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.bot" }));
const markAsRead = vi.fn();
const findNextAppointment = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
const setStatus = vi.fn();
const deriveTaskState = vi.fn(
  (input: { existingTask?: ConversationTask | null; booked: boolean }) =>
    input.booked ? null : (input.existingTask ?? null),
);

vi.mock("@/lib/repo", () => ({
  findEstablishmentByPhoneNumberId: (...a: unknown[]) => findEstablishmentByPhoneNumberId(...a),
  getEstablishment: (...a: unknown[]) => getEstablishment(...a),
  getKnowledgeBase: vi.fn(async () => null),
  loadConversation: (...a: unknown[]) => loadConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  setConversationStatus: vi.fn(),
  closeConversation: (...a: unknown[]) => closeConversation(...a),
  tryCloseAutomatedConversation: (...a: unknown[]) => tryCloseAutomatedConversation(...a),
  reopenConversation: (...a: unknown[]) => reopenConversation(...a),
  setConversationIntent: vi.fn(),
  setConversationTask: (...a: unknown[]) => setConversationTask(...a),
  setConversationSummary: vi.fn(),
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(),
  upsertPendingTask: (...a: unknown[]) => upsertPendingTask(...a),
  resolvePendingTask: (...a: unknown[]) => resolvePendingTask(...a),
  getPendingTask: (...a: unknown[]) => getPendingTask(...a),
  alreadyProcessed: (...a: unknown[]) => alreadyProcessed(...(a as [string])),
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
  findNextAppointment: (...a: unknown[]) => findNextAppointment(...a),
  setStatus: (...a: unknown[]) => setStatus(...a),
  findCustomerNameFromAppointments: vi.fn(async () => null),
}));

const { POST } = await import("@/app/api/webhooks/whatsapp/route");

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
  alreadyProcessed.mockResolvedValue(false);
  tryCloseAutomatedConversation.mockResolvedValue(true);
  getPendingTask.mockResolvedValue(null);
  sendText.mockResolvedValue({ waMessageId: "wamid.bot" });
  findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
  getEstablishment.mockResolvedValue(establishment());
  loadConversation.mockResolvedValue(conversa("bot"));
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
  it("áudio é persistido com phoneNumberId, mas não chama IA, envio nem cria pendência", async () => {
    const audio = payloadMensagem({ type: "audio", omitText: true });
    const msg = audio.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    msg.audio = { id: "media.audio", mime_type: "audio/ogg", sha256: "hash", voice: true };
    const res = await enviarPayload(audio);

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(upsertPendingTask).not.toHaveBeenCalled();
    expect(appendMessage).toHaveBeenCalledWith("est_odonto", PHONE, "customer", "[Áudio recebido]", "wamid.1", {
      kind: "audio",
      phoneNumberId: "pn_1",
      media: { metaMediaId: "media.audio", mimeType: "audio/ogg", sha256: "hash", voice: true },
    });
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

  it("reentrega de mídia pelo mesmo wamid não grava duas mensagens", async () => {
    alreadyProcessed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const audio = payloadMensagem({ type: "audio", omitText: true, id: "wamid.audio.dup" });
    const msg = audio.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    msg.audio = { id: "media.audio" };
    await enviarPayload(audio);
    await enviarPayload(audio);

    expect(appendMessage.mock.calls.filter((c) => c[2] === "customer")).toHaveLength(1);
    expect(think).not.toHaveBeenCalled();
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

  it("mídia durante atendimento humano permanece somente registrada", async () => {
    loadConversation.mockResolvedValue(conversa("human"));
    const image = payloadMensagem({ type: "image", omitText: true });
    const msg = image.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    msg.image = { id: "media.image" };

    const res = await enviarPayload(image);

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(upsertPendingTask).not.toHaveBeenCalled();
    expect(appendMessage).toHaveBeenCalledWith("est_odonto", PHONE, "customer", "[Imagem recebida]", "wamid.1", {
      kind: "image", phoneNumberId: "pn_1", media: { metaMediaId: "media.image" },
    });
  });
});
