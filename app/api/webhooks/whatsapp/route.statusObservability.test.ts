// Diagnóstico de Production (14/09/2026): um envio foi aceito pela Graph API
// (devolveu wamid) mas nunca chegou ao destinatário. O webhook de status
// correspondente (POST 14:45:01) só produziu
// "[livia webhook] no incoming message in payload {"entries":1}" — o código
// nunca olhava value.statuses[], então o status/erro real devolvido pela
// Meta (sent/delivered/read/failed + código de erro) ficava invisível.
//
// Estes testes provam: (1) o webhook de status agora é logado com os campos
// necessários para diagnóstico, (2) continua NUNCA entrando no pipeline de
// IA/persistência, e (3) nada do tratamento existente de messages[] ou de
// eventos de Coexistence regrediu.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { ConversationTask, Establishment } from "@/types";

const APP_SECRET = "segredo-de-teste";
process.env.META_APP_SECRET = APP_SECRET;

const findEstablishmentByPhoneNumberId = vi.fn();
const getEstablishment = vi.fn();
const getConversation = vi.fn();
const loadConversation = vi.fn();
const appendMessage = vi.fn();
const alreadyProcessed = vi.fn(async (_id: string) => false);
const applyCampaignDeliveryStatus = vi.fn(async (..._a: unknown[]) => "not_found");
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
  getEstablishment: (...a: unknown[]) => getEstablishment(...a),
  getConversation: (...a: unknown[]) => getConversation(...a),
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
  applyCampaignDeliveryStatus: (...a: unknown[]) => applyCampaignDeliveryStatus(...a),
  correlateCampaignReply: (...a: unknown[]) => correlateCampaignReply(...a),
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

// ---- helpers ----
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
    whatsapp: {
      wabaId: "waba",
      phoneNumberId: PHONE_NUMBER_ID,
      status: "connected",
      accessToken: { ciphertext: "x", iv: "y", authTag: "z" },
    },
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

function payloadStatus(
  statuses: { id?: string; status?: string; errors?: { code?: number; title?: string; message?: string }[] }[],
) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              statuses,
            },
          },
        ],
      },
    ],
  };
}

function payloadMensagem(overrides: { id?: string; text?: string } = {}) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Ana" } }],
              messages: [
                {
                  id: overrides.id ?? "wamid.in",
                  from: PHONE,
                  type: "text",
                  text: { body: overrides.text ?? "oi" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  alreadyProcessed.mockResolvedValue(false);
  sendText.mockResolvedValue({ waMessageId: "wamid.bot" });
  findEstablishmentByPhoneNumberId.mockResolvedValue(establishment());
  getEstablishment.mockResolvedValue(establishment());
  loadConversation.mockResolvedValue({
    conversation: {
      id: PHONE,
      establishmentId: "est_odonto",
      contactPhone: PHONE,
      contactName: "Ana",
      status: "bot",
      lastMessageAt: 0,
      createdAt: 0,
    },
    history: [],
  });
  getConversation.mockResolvedValue({ id: PHONE, status: "bot" });
  think.mockResolvedValue({
    reply: "Claro!",
    handoff: false,
    booked: false,
    rescheduled: false,
    cancelled: false,
    toolCalls: [],
  });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

function logLines(): string[] {
  return logSpy.mock.calls.map((call: unknown[]) => call.join(" "));
}

describe("Observabilidade de status do WhatsApp", () => {
  it("1) payload só com statuses[] não entra no pipeline de IA/persistência", async () => {
    const res = await enviarPayload(payloadStatus([{ id: "wamid.a", status: "sent" }]));

    expect(res.status).toBe(200);
    expect(alreadyProcessed).not.toHaveBeenCalled();
    // CAMPANHAS-07: agora resolve o tenant para tentar correlacionar o
    // status a um CampaignRecipient (findEstablishmentByPhoneNumberId), mas
    // isso continua sem tocar dedupe/IA/persistência de conversa.
    expect(findEstablishmentByPhoneNumberId).toHaveBeenCalledWith("pn_1");
    expect(applyCampaignDeliveryStatus).toHaveBeenCalledWith("est_odonto", "wamid.a", "sent", undefined);
    expect(think).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("2) status 'failed' registra o código do erro", async () => {
    await enviarPayload(
      payloadStatus([
        {
          id: "wamid.falhou",
          status: "failed",
          errors: [{ code: 131047, title: "Re-engagement message" }],
        },
      ]),
    );

    const lines = logLines();
    const linha = lines.find((l) => l.includes('"status":"failed"'));
    expect(linha).toBeDefined();
    expect(linha).toContain('"errorCode":131047');
    expect(linha).toContain('"errorTitle":"Re-engagement message"');
  });

  it("3) sent/delivered/read são reconhecidos e logados", async () => {
    for (const status of ["sent", "delivered", "read"]) {
      logSpy.mockClear();
      await enviarPayload(payloadStatus([{ id: `wamid.${status}`, status }]));
      const linha = logLines().find((l) => l.includes("status update"));
      expect(linha).toContain(`"status":"${status}"`);
      // Sem erro, nenhum destes campos deve aparecer.
      expect(linha).not.toContain("errorCode");
      expect(linha).not.toContain("errorTitle");
    }
  });

  it("4) o payload de status não é tratado como mensagem inbound (sem customerText/telefone do cliente no log)", async () => {
    await enviarPayload(
      payloadStatus([{ id: "wamid.x", status: "delivered" }]),
    );
    const dump = logLines().join("\n");
    expect(dump).not.toContain(PHONE);
    expect(dump).not.toContain("customerText");
  });

  it("registra a contagem de statuses do payload", async () => {
    await enviarPayload(
      payloadStatus([
        { id: "wamid.1", status: "sent" },
        { id: "wamid.2", status: "delivered" },
      ]),
    );
    const linha = logLines().find((l) => l.includes("status webhook received"));
    expect(linha).toContain('"count":2');
  });

  it("nunca loga access token, secret ou payload bruto", async () => {
    await enviarPayload(
      payloadStatus([
        {
          id: "wamid.falhou",
          status: "failed",
          errors: [{ code: 131047, title: "Re-engagement message", message: "detalhe interno" }],
        },
      ]),
    );
    const dump = logLines().join("\n");
    expect(dump).not.toContain(APP_SECRET);
    expect(dump.toLowerCase()).not.toContain("accesstoken");
  });

  it("5) nenhuma regressão: messages[] continua sendo processado normalmente", async () => {
    const res = await enviarPayload(payloadMensagem());

    expect(res.status).toBe(200);
    expect(findEstablishmentByPhoneNumberId).toHaveBeenCalledTimes(1);
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalled();
  });

  it("6) eventos de sincronização Coexistence continuam ignorados (sem tocar IA/envio)", async () => {
    for (const field of ["smb_message_echoes", "history", "smb_app_state_sync"]) {
      vi.clearAllMocks();
      alreadyProcessed.mockResolvedValue(false);
      const res = await enviarPayload({
        entry: [
          {
            changes: [
              {
                field,
                value: {
                  metadata: { phone_number_id: PHONE_NUMBER_ID },
                  messages: [{ id: `wamid.${field}`, from: PHONE, type: "text", text: { body: "evento espelhado" } }],
                },
              },
            ],
          },
        ],
      });

      expect(res.status).toBe(200);
      expect(findEstablishmentByPhoneNumberId).not.toHaveBeenCalled();
      expect(think).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
    }
  });

  it("status sem errors[] não quebra e não inventa campos de erro", async () => {
    await enviarPayload(payloadStatus([{ id: "wamid.ok", status: "sent" }]));
    const linha = logLines().find((l) => l.includes("status update"));
    expect(linha).toBeDefined();
    expect(linha).not.toContain("errorCode");
    expect(linha).not.toContain("errorTitle");
  });
});
