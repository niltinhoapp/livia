import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
const sendText = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.agent.1" }));
vi.mock("@/lib/whatsapp/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsapp/client")>()),
  sendText: (...a: unknown[]) => sendText(...a),
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { sendAgentReply, WHATSAPP_SERVICE_WINDOW_MS } from "./agentReply";
import type { Message } from "@/types";

const EST = "est-a";
const CONV = "5511900000001";
const NOW = 10_000_000_000;

function seed(status: string, lastCustomerMessageAt = NOW - 60_000) {
  fakeDb.col("establishments").set(EST, { id: EST, whatsapp: { wabaId: "w", phoneNumberId: "p", status: "connected" } });
  fakeDb.col(`establishments/${EST}/conversations`).set(CONV, { id: CONV, establishmentId: EST, contactPhone: CONV, contactName: "Ana", status, lastMessageAt: 0, lastCustomerMessageAt, createdAt: 0 });
}
const reply = (text = "Oi Ana, aqui é a Carla!", clientMessageId = "client-msg-0001") =>
  sendAgentReply({ establishmentId: EST, conversationId: CONV, text, clientMessageId, now: NOW });
const agentMessages = () => [...fakeDb.col(`establishments/${EST}/conversations/${CONV}/messages`).values()].filter((m) => (m as unknown as Message).role === "agent");

beforeEach(() => {
  fakeDb.reset();
  vi.clearAllMocks();
});

describe("resposta do atendente pelo painel", () => {
  it("com a conversa assumida, envia pelo WhatsApp do estabelecimento e grava com autoria 'agent'", async () => {
    seed("human");
    expect(await reply()).toMatchObject({ ok: true, duplicate: false });
    expect(sendText).toHaveBeenCalledWith(expect.anything(), EST, CONV, "Oi Ana, aqui é a Carla!");
    expect(agentMessages()).toEqual([expect.objectContaining({ role: "agent", text: "Oi Ana, aqui é a Carla!", waMessageId: "wamid.agent.1" })]);
  });

  it("sem assumir (bot/handoff) não envia — a Lívia e o humano nunca falam ao mesmo tempo", async () => {
    for (const status of ["bot", "handoff"]) {
      seed(status);
      expect(await reply()).toMatchObject({ ok: false, status: 409 });
    }
    expect(sendText).not.toHaveBeenCalled();
  });

  it("fora da janela de 24h do WhatsApp recusa com mensagem clara", async () => {
    seed("human", NOW - WHATSAPP_SERVICE_WINDOW_MS - 1);
    expect(await reply()).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("24h") });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("Q: toque duplo/retry com o mesmo id não envia duas vezes", async () => {
    seed("human");
    await reply();
    expect(await reply()).toMatchObject({ ok: true, duplicate: true });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(agentMessages()).toHaveLength(1);
  });

  it("falha na Meta: nada gravado no histórico e o reenvio é permitido", async () => {
    seed("human");
    sendText.mockRejectedValueOnce(new Error("meta"));
    expect(await reply()).toMatchObject({ ok: false, status: 502 });
    expect(agentMessages()).toHaveLength(0);
    expect(await reply()).toMatchObject({ ok: true });
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("P: conversa de outro estabelecimento não existe no escopo do tenant", async () => {
    seed("human");
    expect(await sendAgentReply({ establishmentId: "est-b", conversationId: CONV, text: "oi", clientMessageId: "client-msg-0002", now: NOW })).toMatchObject({ ok: false, status: 404 });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("valida texto e identificador de envio", async () => {
    seed("human");
    expect(await reply("   ")).toMatchObject({ ok: false, status: 400 });
    expect(await reply("x".repeat(4097))).toMatchObject({ ok: false, status: 400 });
    expect(await reply("oi", "curto")).toMatchObject({ ok: false, status: 400 });
  });
});
