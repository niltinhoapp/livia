import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted roda antes de qualquer vi.mock e import estático, garantindo
// que a chave exista quando brain → gateway → new OpenAI() é resolvido.
vi.hoisted(() => { process.env.OPENAI_API_KEY ??= "test-prospecting"; });
import { fakeDb, establishmentRef } from "@/lib/__testing__/firestoreFake";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { POST } from "./route";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { upsertProspectingSession } from "@/lib/repo";

const WHATSAPP_TOKEN = "testing-token";
const EST_ID = "auto_establishments_1_fl470n";

beforeEach(() => {
  fakeDb.reset();
  process.env.META_APP_SECRET = WHATSAPP_TOKEN;
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_API_KEY = "test";
  vi.clearAllMocks();

  fakeDb.col("establishments").set(EST_ID, { id: EST_ID,
    bot: {
      name: "Livia",
      bookingEnabled: false,
    },
    whatsapp: {
      status: "connected",
      phoneNumberId: "111",
      wabaId: "waba1",
      pin: { ciphertext: "", iv: "", authTag: "" },
    },
    subscription: { status: "active" },
  });
});

function signPayload(payload: any): string {
  const hmac = createHmac("sha256", WHATSAPP_TOKEN);
  hmac.update(JSON.stringify(payload));
  return `sha256=${hmac.digest("hex")}`;
}

async function sendWebhook(body: any, method = "POST") {
  const sig = signPayload(body);
  const req = new NextRequest(new URL("http://localhost"), {
    method,
    headers: { "x-hub-signature-256": sig, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req);
}

function inboundText(from: string, text: string, waMessageId: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba1",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "222", phone_number_id: "111" },
              contacts: [{ profile: { name: "Test User" }, wa_id: from }],
              messages: [{ from, id: waMessageId, timestamp: Math.floor(Date.now() / 1000).toString(), type: "text", text: { body: text } }],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

function inboundEcho(from: string, text: string, waMessageId: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba1",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "222", phone_number_id: "111" },
              statuses: [{ id: waMessageId, status: "sent", timestamp: Math.floor(Date.now() / 1000).toString(), recipient_id: from }]
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

describe("Prospecção Assistida Inbound Pipeline (F3)", () => {
  const phone = "5511999999999";
  const wamid1 = "wamid.111";

  it("1. contato normal sem sessão mantém comportamento atual", async () => {
    const res = await sendWebhook(inboundText(phone, "Oi", wamid1));
    expect(res.status).toBe(200); console.log("RES BODY:", await res.text());

    const conv = fakeDb.col(`establishments/${EST_ID}/conversations`).get(phone);
    expect(conv).toBeDefined();
    expect(conv?.status).toBe("bot");
    const msgs = fakeDb.col(`establishments/${EST_ID}/conversations/${phone}/messages`).get(wamid1); expect(msgs).toBeDefined(); expect(msgs?.role).toBe("customer");
    expect(msgs?.text).toBe("Oi");
  });

  it("2/3. PREPARED + inbound real → LIVIA_ACTIVE e 4. firstReplyAt gravado", async () => {
    await upsertProspectingSession(EST_ID, {
      leadId: "lead-1",
      phone,
      businessName: "B",
      segment: "S",
      initialManualMessage: "Hello",
    });

    await sendWebhook(inboundText(phone, "Estou interessado", wamid1));

    const session = fakeDb.col(`establishments/${EST_ID}/prospectingSessions`).get(phone);
    expect(session).toBeDefined();
    expect(session?.status).toBe("LIVIA_ACTIVE");
    expect(session?.firstReplyAt).toBeTypeOf("number");
  });

  it("5. segunda mensagem não sobrescreve firstReplyAt e 6. sessão LIVIA_ACTIVE é reconhecida sem regressão", async () => {
    await upsertProspectingSession(EST_ID, {
      leadId: "lead-2",
      phone,
      businessName: "B",
      segment: "S",
      initialManualMessage: "Hello",
    });

    await sendWebhook(inboundText(phone, "Primeira", "wamid.a"));
    const s1 = fakeDb.col(`establishments/${EST_ID}/prospectingSessions`).get(phone);
    const firstAt = s1?.firstReplyAt;

    await new Promise(r => setTimeout(r, 10)); // delay to prove timestamp doesnt change

    await sendWebhook(inboundText(phone, "Segunda", "wamid.b"));
    const s2 = fakeDb.col(`establishments/${EST_ID}/prospectingSessions`).get(phone);
    expect(s2?.status).toBe("LIVIA_ACTIVE");
    expect(s2?.firstReplyAt).toBe(firstAt);
  });

  it("9/10. EXPIRED não engaja e expiresAt vencido marca EXPIRED", async () => {
    const now = Date.now();
    await upsertProspectingSession(EST_ID, {
      leadId: "lead-3",
      phone,
      businessName: "B",
      segment: "S",
      initialManualMessage: "Hello",
      now: now - 50 * 60 * 60 * 1000 // 50h atrás, logo expiresAt foi há 2h
    });

    await sendWebhook(inboundText(phone, "Respondi tarde", wamid1));
    const session = fakeDb.col(`establishments/${EST_ID}/prospectingSessions`).get(phone);
    expect(session?.status).toBe("EXPIRED");
    expect(session?.firstReplyAt).toBeNull();
  });

  it("11/12/13. Estados terminais não engajam", async () => {
    // Simulando CLOSED
    await upsertProspectingSession(EST_ID, {
      leadId: "lead-4",
      phone,
      businessName: "B",
      segment: "S",
      initialManualMessage: "Hello",
    });
    // Forçar transition bypass (na F1, só pode ir a CLOSED se LIVIA_ACTIVE)
    const txDoc = fakeDb.col(`establishments/${EST_ID}/prospectingSessions`).get(phone);
    txDoc!.status = "CLOSED";

    await sendWebhook(inboundText(phone, "Quero voltar", wamid1));
    const session = fakeDb.col(`establishments/${EST_ID}/prospectingSessions`).get(phone);
    expect(session?.status).toBe("CLOSED");
  });

  it("14. message_echo não ativa sessão", async () => {
    await upsertProspectingSession(EST_ID, {
      leadId: "lead-5",
      phone,
      businessName: "B",
      segment: "S",
      initialManualMessage: "Hello",
    });

    await sendWebhook(inboundEcho(phone, "Eco", wamid1));
    const session = fakeDb.col(`establishments/${EST_ID}/prospectingSessions`).get(phone);
    expect(session?.status).toBe("PREPARED"); // não virou LIVIA_ACTIVE
  });
});

