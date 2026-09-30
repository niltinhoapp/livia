// Observabilidade do pipeline + resiliência a falha do LLM, pelo webhook REAL
// sobre o Firestore fake, com o cérebro, as ferramentas, pedidos e agenda
// reais. Só o que sai do sistema é substituído: o modelo de linguagem
// (roteirizado — responde, chama ferramenta ou falha), o envio à Meta e o FCM.
//
// O retry é o do inbox (1 min, 2 min, …): o teste avança o relógio e chama o
// cron de recuperação, como em produção.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY ??= "test-resilience"; });

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb, firebaseAdminApp: {} };
});

type ModelMessage = { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
// O "modelo": cada chamada consulta o roteiro do teste.
let model: (call: number) => ModelMessage | Promise<ModelMessage> = () => ({ content: "Posso ajudar em algo mais?" });
let modelCalls = 0;
vi.mock("@/lib/ai/gateway", () => ({
  AI_COMPLETION_TIMEOUT_MS: 20_000,
  runCompletion: vi.fn(async () => model(++modelCalls)),
}));
// O Firestore fake não conhece sentinelas: FieldValue.delete() viraria {} no
// documento. Em produção o campo some — é essa semântica que o teste precisa.
vi.mock("firebase-admin/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase-admin/firestore")>()),
  FieldValue: { delete: () => undefined },
}));
vi.mock("@/lib/ai/summarize", () => ({ summarizeConversation: vi.fn(async () => null) }));

let sentCount = 0;
const sendText = vi.fn(async (..._a: unknown[]) => ({ waMessageId: `wamid.out.${++sentCount}` }));
const sendTemplate = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.template.1" }));
vi.mock("@/lib/whatsapp/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsapp/client")>()),
  sendText: (...a: unknown[]) => sendText(...a),
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  markAsRead: vi.fn(async () => undefined),
}));

const sendEachForMulticast = vi.fn(async ({ tokens }: { tokens: string[] }) => ({
  successCount: tokens.length,
  failureCount: 0,
  responses: tokens.map(() => ({ success: true, messageId: "fcm-1" })),
}));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: () => ({ sendEachForMulticast: (...a: unknown[]) => (sendEachForMulticast as (...args: unknown[]) => unknown)(...a) }) }));

import { createHmac } from "node:crypto";
import OpenAI from "openai";
import { NextRequest } from "next/server";
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { seedDemoCatalog } from "@/lib/demo/catalog";
import { getActiveOrder, listOrders } from "@/lib/orders";
import { claimsOrderConfirmed } from "@/lib/ai/brain";
import { LLM_CONTINGENCY_REPLY } from "@/lib/ai/llmContingency";
import { setTraceSink } from "@/lib/pipelineTrace";
import type { Conversation } from "@/types";

const { POST } = await import("./route");
const { GET: cron } = await import("@/app/api/cron/whatsapp-inbound-recovery/route");

const SECRET = "resilience-secret";
const EST = "est_resiliencia";
const CUSTOMER = "5514977776666";
const CUSTOMER_TEXT_MARKER = "quero um x-burger";
const T0 = new Date("2026-10-05T17:00:00.000Z").getTime();
let wamid = 0;

const timeout = () => new OpenAI.APIConnectionTimeoutError();
const rateLimited = () => new OpenAI.RateLimitError(429, undefined, "rate limited", {});
const say = (content: string): ModelMessage => ({ content });
const call = (name: string, args: Record<string, unknown>): ModelMessage => ({
  content: null,
  tool_calls: [{ id: `c-${name}-${modelCalls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

function establishment(bot: Record<string, unknown> = {}) {
  return {
    id: EST, name: "Lanchonete do Bairro", type: "restaurante", ownerUid: "owner-1", status: "active", createdAt: 0,
    bot: { personaName: "Lívia", tone: "", bookingEnabled: false, ordersEnabled: false, handoffKeywords: [], medicalGuardrail: false, ...bot },
    whatsapp: { wabaId: "waba1", phoneNumberId: "pn-resiliencia", status: "connected", pin: { ciphertext: "", iv: "", authTag: "" } },
    humanHandoffNotifications: {
      push: true, whatsapp: true, responsiblePhone: "5514999990000",
      templateName: "aviso_atendimento", templateLang: "pt_BR", templateParamCount: 2, updatedAt: 0,
    },
  };
}

async function webhook(id: string, text: string) {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "waba1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "1433334444", phone_number_id: "pn-resiliencia" },
      contacts: [{ profile: { name: "Ana" }, wa_id: CUSTOMER }],
      messages: [{ from: CUSTOMER, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
    } }] }],
  });
  const req = new NextRequest(new URL("http://localhost/api/webhooks/whatsapp"), {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`, "content-type": "application/json" },
    body: raw,
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
}

async function customerSays(text: string) {
  const id = `wamid.in.${++wamid}`;
  await webhook(id, text);
  return id;
}

// Avança o relógio além do backoff do inbox e roda o cron de recuperação.
async function retryAfter(ms: number) {
  vi.setSystemTime(Date.now() + ms);
  const res = await cron(new NextRequest(new URL("http://localhost/api/cron/whatsapp-inbound-recovery"), {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }));
  expect(res.status).toBe(200);
}

const conversation = () => fakeDb.col(`establishments/${EST}/conversations`).get(CUSTOMER) as unknown as Conversation;
const pending = () => fakeDb.col(`establishments/${EST}/pendingTasks`).get(CUSTOMER) as Record<string, unknown> | undefined;
const sentTexts = () => sendText.mock.calls.map((c) => String(c[3]));
const jobs = () => fakeDb.col("_wa_inbound_jobs").size;
const deadLetters = () => fakeDb.col("_wa_inbound_dead_letters").size;

let traceLines: string[] = [];
const traced = () => traceLines.map((l) => JSON.parse(l.replace(/^\[trace\] /, "")) as Record<string, unknown>);

beforeEach(async () => {
  fakeDb.reset();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.META_APP_SECRET = SECRET;
  process.env.CRON_SECRET = "cron-secret";
  process.env.APP_BASE_URL = "https://app.livia.test";
  sentCount = 0;
  modelCalls = 0;
  model = () => say("Posso ajudar em algo mais?");
  traceLines = [];
  setTraceSink((line) => traceLines.push(line));
  fakeDb.col("establishments").set(EST, establishment());
  fakeDb.col(`establishments/${EST}/meta`).set("knowledge", {
    establishmentId: EST, about: "Lanchonete de bairro", address: "Rua A, 1", hours: "9h às 22h",
    services: [{ name: "Avaliação", priceText: "R$ 120", durationText: "40 min", description: null }],
    faqs: [], notes: null, paymentMethods: "Pix, dinheiro e cartão", importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0,
  });
  fakeDb.col(`establishments/${EST}/pushDevices`).set("device-1", { id: "device-1", token: "fcm-token-celular-do-dono-000000000000", uid: "owner-1", userAgent: null, createdAt: 0, lastSeenAt: 0 });
});

afterEach(() => {
  setTraceSink(null);
  vi.useRealTimers();
  delete process.env.APP_BASE_URL;
  delete process.env.CRON_SECRET;
});

describe("LLM normal: comportamento inalterado + trace completo", () => {
  it("responde uma vez e o trace reconstrói o caminho da mensagem sem dado sensível", async () => {
    model = () => say("Oi, Ana! Como posso ajudar?");
    await customerSays("oi, tudo bem? meu telefone é 5514977776666");

    expect(sentTexts()).toEqual(["Oi, Ana! Como posso ajudar?"]);
    expect(conversation()).toMatchObject({ status: "bot" });
    expect(pending()).toBeUndefined();
    expect(jobs()).toBe(0);

    const events = traced();
    expect(events.map((e) => e.event)).toEqual([
      "message_received", "tenant_resolved", "message_queued",
      "conversation_loaded", "conversation_mode", "handoff_state", "task_state", "context_built",
      "llm_requested", "llm_completed", "message_queued", "message_sent", "processing_completed",
    ]);
    // Uma mensagem = um traceId, do recebimento ao envio.
    expect(new Set(events.map((e) => e.traceId)).size).toBe(1);
    expect(events.find((e) => e.event === "llm_completed")).toMatchObject({ outcome: "reply", round: 1 });
    expect(events.find((e) => e.event === "message_sent")).toMatchObject({ delivered: true });
    expect(events.find((e) => e.event === "processing_completed")).toMatchObject({ outcome: "processed", attempt: 1 });
    const all = traceLines.join("\n");
    expect(all).not.toMatch(/tudo bem|5514977776666|Ana|wamid\.in/);
  });

  it("ferramentas aparecem no trace só com nome e desfecho", async () => {
    fakeDb.col("establishments").set(EST, establishment({ ordersEnabled: true }));
    await seedDemoCatalog(EST);
    model = (n) => (n === 1 ? call("list_menu", {}) : say("Temos lanches e bebidas."));
    await customerSays("o que tem no cardápio?");

    const events = traced();
    expect(events.find((e) => e.event === "tool_requested")).toMatchObject({ tool: "list_menu", argsCount: 0 });
    expect(events.find((e) => e.event === "tool_result")).toMatchObject({ tool: "list_menu", ok: true });
    expect(events.filter((e) => e.event === "llm_requested").map((e) => e.round)).toEqual([1, 2]);
  });
});

describe("falha transitória do LLM", () => {
  it("timeout na 1ª tentativa: nada sai; o retry existente recupera com UMA resposta normal", async () => {
    model = (n) => { if (n === 1) throw timeout(); return say("Oi! Como posso ajudar?"); };
    await customerSays("oi");

    expect(sendText).not.toHaveBeenCalled();
    expect(jobs()).toBe(1);
    expect(conversation()).toMatchObject({ status: "bot" });
    expect(traced().find((e) => e.event === "llm_completed")).toMatchObject({ outcome: "error", errorKind: "timeout" });
    expect(traced().find((e) => e.event === "guardrail_result")).toMatchObject({ guard: "llm_contingency", kind: "timeout", action: "retry" });
    expect(traced().find((e) => e.event === "processing_failed")).toMatchObject({ outcome: "retry_scheduled", attempt: 1 });

    await retryAfter(61_000);

    expect(sentTexts()).toEqual(["Oi! Como posso ajudar?"]);
    expect(conversation()).toMatchObject({ status: "bot" });
    expect(pending()).toBeUndefined();
    expect(jobs()).toBe(0);
    expect(traced().filter((e) => e.event === "processing_completed").at(-1)).toMatchObject({ outcome: "processed", attempt: 2 });
    // Mais ciclos do cron não reprocessam nem reenviam.
    await retryAfter(10 * 60_000);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(modelCalls).toBe(2);
  });
});

describe("falha persistente do LLM", () => {
  it("3ª falha seguida: UMA mensagem de contingência, conversa com a equipe, pendência e aviso ao responsável", async () => {
    model = () => { throw rateLimited(); };
    await customerSays("oi, vocês abrem hoje?");
    await retryAfter(61_000);
    expect(sendText).not.toHaveBeenCalled();
    expect(conversation()).toMatchObject({ status: "bot" });

    await retryAfter(121_000);

    expect(sentTexts()).toEqual([LLM_CONTINGENCY_REPLY]);
    expect(conversation()).toMatchObject({ status: "handoff" });
    expect(pending()).toMatchObject({ type: "awaiting_human", status: "open" });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    // A mensagem do cliente continua no histórico e o job terminou (sem dead letter).
    const history = [...fakeDb.col(`establishments/${EST}/conversations/${CUSTOMER}/messages`).values()] as Array<{ role: string; text: string }>;
    expect(history.filter((m) => m.role === "customer").map((m) => m.text)).toEqual(["oi, vocês abrem hoje?"]);
    expect(history.filter((m) => m.role === "bot").map((m) => m.text)).toEqual([LLM_CONTINGENCY_REPLY]);
    expect(jobs()).toBe(0);
    expect(deadLetters()).toBe(0);
    expect(traced().find((e) => e.event === "guardrail_result" && e.action === "handoff_notified")).toMatchObject({ kind: "rate_limited", attempt: 3 });

    // Sem loop: o cron seguinte não chama o modelo nem reenvia.
    const callsAfterContingency = modelCalls;
    await retryAfter(10 * 60_000);
    await retryAfter(60 * 60_000);
    expect(modelCalls).toBe(callsAfterContingency);
    expect(sendText).toHaveBeenCalledTimes(1);

    // A próxima mensagem do cliente é da equipe: a Lívia não responde de novo.
    await customerSays("alô?");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(modelCalls).toBe(callsAfterContingency);
    expect(conversation()).toMatchObject({ status: "handoff" });
  });

  it("rejeição do provedor (4xx) age na primeira falha, sem retries inúteis", async () => {
    model = () => { throw new OpenAI.BadRequestError(400, undefined, "bad request", {}); };
    await customerSays("oi");
    expect(sentTexts()).toEqual([LLM_CONTINGENCY_REPLY]);
    expect(conversation()).toMatchObject({ status: "handoff" });
    expect(modelCalls).toBe(1);
    expect(jobs()).toBe(0);
  });
});

describe("falha do LLM x handoff humano existente", () => {
  it("conversa já em handoff: o LLM nem é chamado e nenhuma contingência sai", async () => {
    model = () => { throw timeout(); };
    fakeDb.col(`establishments/${EST}/conversations`).set(CUSTOMER, {
      id: CUSTOMER, establishmentId: EST, contactPhone: CUSTOMER, contactName: "Ana", status: "handoff",
      handoffStartedAt: T0 - 60_000, lastMessageAt: T0 - 60_000, lastMessagePreview: "", unreadCount: 0, createdAt: T0 - 120_000,
    });
    await customerSays("ainda estou aguardando");
    expect(modelCalls).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
    expect(conversation()).toMatchObject({ status: "handoff" });
    expect(traced().find((e) => e.event === "handoff_state")).toMatchObject({ status: "handoff", automation: "silent" });
  });

  it("humano assume entre as tentativas: a 3ª não chama o LLM, não envia contingência e não mexe no status", async () => {
    model = () => { throw timeout(); };
    await customerSays("oi");
    await retryAfter(61_000);
    fakeDb.col(`establishments/${EST}/conversations`).set(CUSTOMER, { ...conversation(), status: "human" });

    await retryAfter(121_000);

    expect(modelCalls).toBe(2);
    expect(sendText).not.toHaveBeenCalled();
    expect(conversation()).toMatchObject({ status: "human" });
    expect(jobs()).toBe(0);
  });

  it("humano assume DURANTE a 3ª chamada que falha: a contingência não sobrescreve o atendimento", async () => {
    model = (n) => {
      if (n === 3) fakeDb.col(`establishments/${EST}/conversations`).set(CUSTOMER, { ...conversation(), status: "human" });
      throw timeout();
    };
    await customerSays("oi");
    await retryAfter(61_000);
    await retryAfter(121_000);

    expect(sendText).not.toHaveBeenCalled();
    expect(conversation()).toMatchObject({ status: "human" });
    expect(traced().find((e) => e.event === "guardrail_result" && e.action === "skipped_not_owner")).toBeDefined();
    // O retry seguinte cai no caminho silencioso do atendimento humano.
    await retryAfter(5 * 60_000);
    expect(sendText).not.toHaveBeenCalled();
    expect(modelCalls).toBe(3);
    expect(conversation()).toMatchObject({ status: "human" });
    expect(pending()).toMatchObject({ type: "awaiting_human" });
    expect(jobs()).toBe(0);
  });
});

describe("deduplicação e idempotência", () => {
  it("webhook duplicado não reprocessa: nem durante o retry pendente, nem depois de concluído", async () => {
    model = (n) => { if (n === 1) throw timeout(); return say("Oi! Em que posso ajudar?"); };
    const id = await customerSays("oi");
    // Reentrega da Meta enquanto o job aguarda o backoff.
    await webhook(id, "oi");
    expect(modelCalls).toBe(1);
    expect(sendText).not.toHaveBeenCalled();

    await retryAfter(61_000);
    await webhook(id, "oi");
    await webhook(id, "oi");

    expect(modelCalls).toBe(2);
    expect(sentTexts()).toEqual(["Oi! Em que posso ajudar?"]);
    expect(traced().filter((e) => e.event === "processing_completed" && e.outcome === "duplicate_ignored")).toHaveLength(2);
  });

  it("resposta anterior do mesmo job já tem intenção de envio: a contingência não manda um segundo texto nem corrompe o outbox", async () => {
    const { WhatsAppTextSendError } = await import("@/lib/whatsapp/client");
    model = (n) => { if (n === 1) return say("Oi! Como posso ajudar?"); throw timeout(); };
    sendText.mockImplementationOnce(async () => { throw new WhatsAppTextSendError("text_send_failed", 500); });
    const id = await customerSays("oi");
    expect(fakeDb.col("_wa_outbound_intents").get(id)).toMatchObject({ state: "pending", text: "Oi! Como posso ajudar?" });

    await retryAfter(61_000);
    await retryAfter(121_000);

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(conversation()).toMatchObject({ status: "handoff" });
    expect(pending()).toMatchObject({ type: "awaiting_human", status: "open" });
    expect(fakeDb.col("_wa_outbound_intents").get(id)).toMatchObject({ state: "pending", text: "Oi! Como posso ajudar?" });
    expect(deadLetters()).toBe(0);
    expect(jobs()).toBe(0);
    expect(traced().find((e) => e.event === "guardrail_result" && e.guard === "llm_contingency" && e.action !== "retry")).toMatchObject({ action: "handoff_silent" });
  });

  it("contingência aplicada + reentrega da mesma mensagem: nenhuma segunda contingência", async () => {
    model = () => { throw timeout(); };
    const id = await customerSays("oi");
    await retryAfter(61_000);
    await retryAfter(121_000);
    await webhook(id, "oi");
    await retryAfter(5 * 60_000);
    expect(sentTexts()).toEqual([LLM_CONTINGENCY_REPLY]);
  });
});

describe("a contingência não executa negócio", () => {
  it("pedido aguardando confirmação + 'sim' com o LLM fora: o pedido NÃO é confirmado", async () => {
    fakeDb.col("establishments").set(EST, establishment({ ordersEnabled: true }));
    await seedDemoCatalog(EST);
    const turns: ModelMessage[][] = [
      [call("add_order_item", { productId: "demo-prod-xburger", quantity: 1, __allowDraftCreation: true }), say("X-Burger anotado. Retirada ou entrega?")],
      [call("set_order_fulfillment", { fulfillment: "pickup" }), say("Retirada. Como vai pagar?")],
      [call("set_order_payment", { method: "pix" }), call("prepare_order_confirmation", {})],
    ];
    let script: ModelMessage[] = [];
    model = () => script.shift() ?? say("Anotado!");
    for (const [text, answers] of [[CUSTOMER_TEXT_MARKER, turns[0]!], ["retirada", turns[1]!], ["pix", turns[2]!]] as const) {
      script = [...answers];
      await customerSays(text);
    }
    const awaiting = await getActiveOrder(EST, CUSTOMER);
    expect(awaiting?.status).toBe("awaiting_confirmation");
    const repliesBefore = sendText.mock.calls.length;

    model = () => { throw timeout(); };
    await customerSays("sim, pode confirmar");
    await retryAfter(61_000);
    await retryAfter(121_000);

    const after = await getActiveOrder(EST, CUSTOMER);
    expect(after).toMatchObject({ id: awaiting!.id, status: "awaiting_confirmation", version: awaiting!.version });
    expect(await listOrders(EST)).toEqual([]);
    expect(sentTexts().slice(repliesBefore)).toEqual([LLM_CONTINGENCY_REPLY]);
    expect(claimsOrderConfirmed(LLM_CONTINGENCY_REPLY)).toBe(false);
    expect(traced().some((e) => e.event === "tool_requested" && e.tool === "confirm_order")).toBe(false);
    expect(conversation()).toMatchObject({ status: "handoff" });
  });

  it("falha no meio do loop de ferramentas de agenda: nenhum agendamento é criado nem anunciado", async () => {
    fakeDb.col("establishments").set(EST, establishment({ bookingEnabled: true }));
    // Cada tentativa: a 1ª rodada consulta a agenda, a 2ª falha.
    model = (n) => {
      if (n % 2 === 1) return call("find_available_appointments", { date: "2026-10-06" });
      throw timeout();
    };
    await customerSays("quero marcar uma avaliação amanhã às 15h");
    await retryAfter(61_000);
    await retryAfter(121_000);

    expect(fakeDb.col(`establishments/${EST}/appointments`).size).toBe(0);
    expect(sentTexts()).toEqual([LLM_CONTINGENCY_REPLY]);
    expect(LLM_CONTINGENCY_REPLY).not.toMatch(/agend|marcad|reserv|confirm|hor[áa]rio|dispon/i);
    expect(traced().filter((e) => e.event === "tool_requested").every((e) => e.tool === "find_available_appointments")).toBe(true);
    expect(conversation()).toMatchObject({ status: "handoff" });
  });
});

describe("falha da própria telemetria", () => {
  it("destino de trace quebrado não derruba o atendimento", async () => {
    setTraceSink(() => { throw new Error("log pipeline down"); });
    model = () => say("Oi! Como posso ajudar?");
    await customerSays("oi");
    expect(sentTexts()).toEqual(["Oi! Como posso ajudar?"]);
    expect(conversation()).toMatchObject({ status: "bot" });
    expect(jobs()).toBe(0);
  });
});
