// Handoff humano de ponta a ponta, pelo webhook REAL sobre o Firestore fake:
// pedido de humano → aviso ao responsável → mensagens seguintes → assumir →
// horas/dias depois → resposta do atendente → "Devolver para Lívia" → a Lívia
// volta a responder com o histórico do atendimento humano.
//
// Só o que sai do sistema é substituído: o cérebro (resposta roteirizada), o
// envio à Meta (sendText/sendTemplate) e o FCM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY ??= "test-handoff"; });

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb, firebaseAdminApp: {} };
});

const think = vi.fn();
vi.mock("@/lib/ai/brain", () => ({ think: (...a: unknown[]) => think(...a) }));
vi.mock("@/lib/ai/summarize", () => ({ summarizeConversation: vi.fn(async () => null) }));

let sentCount = 0;
const sendText = vi.fn(async () => ({ waMessageId: `wamid.out.${++sentCount}` }));
const sendTemplate = vi.fn(async () => ({ waMessageId: "wamid.template.1" }));
vi.mock("@/lib/whatsapp/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsapp/client")>()),
  sendText: (...a: unknown[]) => (sendText as (...args: unknown[]) => unknown)(...a),
  sendTemplate: (...a: unknown[]) => (sendTemplate as (...args: unknown[]) => unknown)(...a),
  markAsRead: vi.fn(async () => undefined),
}));

const sendEachForMulticast = vi.fn(async ({ tokens }: { tokens: string[] }) => ({
  successCount: tokens.length,
  failureCount: 0,
  responses: tokens.map(() => ({ success: true, messageId: "fcm-1" })),
}));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: () => ({ sendEachForMulticast: (...a: unknown[]) => (sendEachForMulticast as (...args: unknown[]) => unknown)(...a) }) }));

let actor: { establishmentId: string; uid: string } | null = null;
vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: vi.fn(async () => actor?.establishmentId ?? null),
  resolvePanelActor: vi.fn(async () => actor),
}));

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import type { Conversation, HandoffNotificationRecord, Message } from "@/types";

const { POST } = await import("./route");
const { PATCH } = await import("@/app/api/conversations/[id]/route");

const SECRET = "handoff-secret";
const EST = "est_pizzaria";
const CUSTOMER = "5514988887777";
const T0 = new Date("2026-10-06T13:00:00.000Z").getTime();
let wamid = 0;

function establishment(over: Record<string, unknown> = {}) {
  return {
    id: EST, name: "Pizzaria do Bairro", type: "pizzaria", ownerUid: "owner-1", status: "active", createdAt: 0,
    bot: { personaName: "Lívia", tone: "", bookingEnabled: false, ordersEnabled: false, handoffKeywords: [], medicalGuardrail: false },
    whatsapp: { wabaId: "waba1", phoneNumberId: "pn-pizzaria", status: "connected", pin: { ciphertext: "", iv: "", authTag: "" } },
    humanHandoffNotifications: {
      push: true, whatsapp: true, responsiblePhone: "5514999990000",
      templateName: "aviso_atendimento", templateLang: "pt_BR", templateParamCount: 2, updatedAt: 0,
    },
    ...over,
  };
}

async function webhook(body: unknown) {
  const raw = JSON.stringify(body);
  const req = new NextRequest(new URL("http://localhost/api/webhooks/whatsapp"), {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`, "content-type": "application/json" },
    body: raw,
  });
  return POST(req);
}

async function customerSays(text: string) {
  return webhook({
    object: "whatsapp_business_account",
    entry: [{ id: "waba1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "1433334444", phone_number_id: "pn-pizzaria" },
      contacts: [{ profile: { name: "Ana" }, wa_id: CUSTOMER }],
      messages: [{ from: CUSTOMER, id: `wamid.in.${++wamid}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
    } }] }],
  });
}

async function agentRepliesFromBusinessApp(text: string, id: string) {
  return webhook({
    object: "whatsapp_business_account",
    entry: [{ id: "waba1", changes: [{ field: "smb_message_echoes", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "1433334444", phone_number_id: "pn-pizzaria" },
      message_echoes: [{ from: "551433334444", to: CUSTOMER, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
    } }] }],
  });
}

async function panel(action: "assume" | "return") {
  const req = new Request(`https://livia.test/api/conversations/${CUSTOMER}`, { method: "PATCH", body: JSON.stringify({ action }) });
  return PATCH(req as never, { params: Promise.resolve({ id: CUSTOMER }) });
}

const conversation = () => fakeDb.col(`establishments/${EST}/conversations`).get(CUSTOMER) as unknown as Conversation;
const messages = () => [...fakeDb.col(`establishments/${EST}/conversations/${CUSTOMER}/messages`).values()] as unknown as Message[];
const episodes = () => [...fakeDb.col(`establishments/${EST}/handoffNotifications`).values()] as unknown as HandoffNotificationRecord[];
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  fakeDb.reset();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.META_APP_SECRET = SECRET;
  process.env.APP_BASE_URL = "https://app.livia.test";
  actor = { establishmentId: EST, uid: "owner-1" };
  sentCount = 0;
  fakeDb.col("establishments").set(EST, establishment());
  fakeDb.col(`establishments/${EST}/pushDevices`).set("device-1", { id: "device-1", token: "fcm-token-celular-do-dono-000000000000", uid: "owner-1", userAgent: null, createdAt: 0, lastSeenAt: 0 });
  think.mockResolvedValue({ reply: "Claro! Vou chamar uma pessoa da equipe.", handoff: true, booked: false, rescheduled: false, cancelled: false, toolCalls: [] });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.APP_BASE_URL;
});

describe("handoff humano comercial — jornada completa", () => {
  it("A→O: pedido, aviso único, silêncio, assumir, dias depois, eco do atendente, devolver e Lívia com histórico", async () => {
    // A/B/E: pedido explícito de humano confirma o handoff e avisa pelos dois canais.
    await customerSays("quero falar com um atendente");
    expect(conversation()).toMatchObject({ status: "handoff", handoffStartedAt: T0 });
    expect(fakeDb.col(`establishments/${EST}/pendingTasks`).get(CUSTOMER)).toMatchObject({ type: "awaiting_human", status: "open" });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.anything(), EST, "5514999990000", "aviso_atendimento", "pt_BR", ["Ana", `https://app.livia.test/painel/conversas?conversa=${CUSTOMER}`]);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast.mock.calls[0]![0]).toMatchObject({ data: { url: `/painel/conversas?conversa=${CUSTOMER}` } });
    expect(episodes()[0]).toMatchObject({ push: { status: "sent", delivered: 1 }, whatsapp: { status: "sent", waMessageId: "wamid.template.1" } });

    // G: várias mensagens em sequência — registradas, sem resposta da IA, sem novo template, sem spam de push.
    think.mockClear();
    const sentBefore = sendText.mock.calls.length;
    for (const text of ["oi?", "alguém aí?", "preciso mudar meu pedido"]) await customerSays(text);
    expect(think).not.toHaveBeenCalled();
    expect(sendText.mock.calls.length).toBe(sentBefore);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(messages().filter((m) => m.role === "customer").map((m) => m.text)).toEqual(expect.arrayContaining(["oi?", "alguém aí?", "preciso mudar meu pedido"]));

    // H: responsável assume.
    expect(await (await panel("assume")).json()).toMatchObject({ status: "human" });

    // I/J/K: horas e dias depois o cliente escreve — continua humano, IA calada, nada volta sozinho.
    advance(31 * 60 * 1000);
    await customerSays("vocês ainda estão aí?");
    expect(conversation().status).toBe("human");
    expect(sendEachForMulticast).toHaveBeenCalledTimes(2); // reaviso só por push, depois do intervalo
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    advance(3 * 24 * 60 * 60 * 1000);
    await customerSays("oi, voltei depois de 3 dias");
    expect(conversation().status).toBe("human");
    expect(think).not.toHaveBeenCalled();
    expect(sendText.mock.calls.length).toBe(sentBefore);

    // O: resposta do atendente pelo app WhatsApp Business entra no histórico com autoria correta.
    await agentRepliesFromBusinessApp("Oi Ana! Troquei sua pizza para calabresa, chega em 30 min.", "wamid.echo.1");
    await agentRepliesFromBusinessApp("Oi Ana! Troquei sua pizza para calabresa, chega em 30 min.", "wamid.echo.1");
    expect(messages().filter((m) => m.role === "agent")).toHaveLength(1);
    expect(think).not.toHaveBeenCalled();
    expect(conversation().status).toBe("human");

    // M/N: só "Devolver para Lívia" reativa a IA — que então responde com o histórico humano.
    expect(await (await panel("return")).json()).toMatchObject({ status: "bot" });
    think.mockResolvedValue({ reply: "Perfeito, Ana! Sua calabresa já está a caminho.", handoff: false, booked: false, rescheduled: false, cancelled: false, toolCalls: [] });
    await customerSays("obrigada! e a bebida?");
    expect(think).toHaveBeenCalledTimes(1);
    const history = (think.mock.calls[0]![0] as { history: Message[] }).history;
    expect(history.map((m) => m.role)).toContain("agent");
    expect(history.find((m) => m.role === "agent")?.text).toContain("calabresa");
    expect(history.map((m) => m.text)).toEqual(expect.arrayContaining(["oi, voltei depois de 3 dias", "obrigada! e a bebida?"]));
    expect(sendText.mock.calls.length).toBe(sentBefore + 1);
    expect(conversation().status).toBe("bot");
  });

  it("F: falha do template e do push não desfaz o handoff nem a resposta ao cliente", async () => {
    sendTemplate.mockRejectedValueOnce(new Error("WhatsApp sendTemplate falhou: {\"status\":400}"));
    sendEachForMulticast.mockRejectedValueOnce(new Error("fcm down"));
    await customerSays("quero falar com um humano");
    expect(conversation().status).toBe("handoff");
    expect(fakeDb.col(`establishments/${EST}/pendingTasks`).get(CUSTOMER)).toMatchObject({ status: "open" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(episodes()[0]).toMatchObject({ push: { status: "failed" }, whatsapp: { status: "failed" } });
  });

  it("Q: webhook duplicado (mesmo wamid) não duplica handoff nem aviso", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "waba1", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp", metadata: { display_phone_number: "1433334444", phone_number_id: "pn-pizzaria" },
        contacts: [{ profile: { name: "Ana" }, wa_id: CUSTOMER }],
        messages: [{ from: CUSTOMER, id: "wamid.dup.1", timestamp: String(Math.floor(T0 / 1000)), type: "text", text: { body: "quero falar com um atendente" } }],
      } }] }],
    };
    await webhook(payload);
    await webhook(payload);
    expect(think).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(episodes()).toHaveLength(1);
  });

  it("sem responsável configurado o handoff acontece normalmente, sem aviso", async () => {
    fakeDb.col("establishments").set(EST, establishment({ humanHandoffNotifications: undefined }));
    await customerSays("quero falar com um atendente");
    expect(conversation().status).toBe("handoff");
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it("C/D: somente push ou somente WhatsApp, conforme a preferência", async () => {
    fakeDb.col("establishments").set(EST, establishment({ humanHandoffNotifications: { ...establishment().humanHandoffNotifications, whatsapp: false } }));
    await customerSays("quero falar com um atendente");
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(sendTemplate).not.toHaveBeenCalled();

    await panel("return");
    vi.clearAllMocks();
    fakeDb.col("establishments").set(EST, establishment({ humanHandoffNotifications: { ...establishment().humanHandoffNotifications, push: false } }));
    advance(60_000);
    await customerSays("quero falar com um atendente de novo");
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it("conta suspensa: nenhuma IA, nenhum handoff novo e nenhum aviso", async () => {
    fakeDb.col("establishments").set(EST, establishment({ status: "suspended" }));
    await customerSays("quero falar com um atendente");
    expect(think).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
    expect(conversation().status).toBe("bot");
  });

  it("Q: assumir no painel enquanto a IA ainda processa descarta a resposta automática", async () => {
    think.mockImplementationOnce(async () => {
      await panel("assume");
      return { reply: "Resposta automática que não pode sair.", handoff: false, booked: false, rescheduled: false, cancelled: false, toolCalls: [] };
    });
    await customerSays("oi, qual o horário?");
    expect(conversation().status).toBe("human");
    expect(sendText).not.toHaveBeenCalled();
  });
});
