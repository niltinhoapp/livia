// Cobertura do pipeline completo do webhook (auditoria de 04/09/2026: um
// POST real da Meta voltava 200 em ~8ms, sem nenhuma chamada externa — a
// mensagem nunca chegava a ser processada, e nada nos logs dizia por quê).
//
// Estes testes provam que "POST 200" e "mensagem processada" são coisas
// diferentes: cada cenário confirma o que REALMENTE aconteceu (think foi
// chamado? sendText foi chamado? o erro subiu ou foi engolido?), não só o
// status HTTP da resposta.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Establishment } from "@/types";

const APP_SECRET = "segredo-de-teste";
process.env.META_APP_SECRET = APP_SECRET;

// ---- dublês ----
const findEstablishmentByPhoneNumberId = vi.fn();
const loadConversation = vi.fn();
const appendMessage = vi.fn();
const alreadyProcessed = vi.fn(async (_id: string) => false);
const think = vi.fn();
const sendText = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.bot" }));
const markAsRead = vi.fn();

vi.mock("@/lib/repo", () => ({
  findEstablishmentByPhoneNumberId: (...a: unknown[]) => findEstablishmentByPhoneNumberId(...a),
  getEstablishment: vi.fn(async () => null),
  getKnowledgeBase: vi.fn(async () => null),
  loadConversation: (...a: unknown[]) => loadConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  setConversationStatus: vi.fn(),
  setConversationIntent: vi.fn(),
  setConversationTask: vi.fn(),
  setConversationSummary: vi.fn(),
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(),
  upsertPendingTask: vi.fn(),
  resolvePendingTask: vi.fn(),
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
  findNextAppointment: vi.fn(async () => null),
  setStatus: vi.fn(),
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

function conversa(status: "bot" | "handoff" | "human" | "closed" = "bot") {
  return {
    conversation: { id: PHONE, establishmentId: "est_odonto", contactPhone: PHONE, contactName: "Ana", status, lastMessageAt: 0, createdAt: 0 },
    history: [],
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

function payloadMensagem(overrides: { type?: string; omitText?: boolean; id?: string } = {}) {
  const msg: Record<string, unknown> = {
    id: overrides.id ?? "wamid.1",
    from: PHONE,
    type: overrides.type ?? "text",
  };
  if (!overrides.omitText) msg.text = { body: "cancela esse" };
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
  sendText.mockResolvedValue({ waMessageId: "wamid.bot" });
  findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
  loadConversation.mockResolvedValue(conversa("bot"));
  think.mockResolvedValue({
    reply: "Claro! Posso te ajudar com isso.",
    handoff: false,
    booked: false,
    rescheduled: false,
    cancelled: false,
    toolCalls: [],
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

describe("2 — mensagem sem texto (áudio/imagem/sem corpo)", () => {
  it("tipo diferente de texto: 200, mas a IA NUNCA é chamada", async () => {
    const res = await enviarPayload(payloadMensagem({ type: "audio", omitText: true }));

    expect(res.status).toBe(200);
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
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
});
