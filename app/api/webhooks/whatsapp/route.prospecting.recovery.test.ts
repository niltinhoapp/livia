import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted roda antes de qualquer vi.mock e import estático, garantindo
// que a chave exista quando brain → gateway → new OpenAI() é resolvido.
vi.hoisted(() => { process.env.OPENAI_API_KEY ??= "test-recovery"; });
import { fakeDb } from "@/lib/__testing__/firestoreFake";

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

const sendTextMock = vi.fn(async (..._args: unknown[]) => ({ waMessageId: "wamid.mock.123" }));

// route.ts envia via @/lib/whatsapp/client (sendText) e @/lib/whatsapp/outbox
// (executeDurableWhatsAppOutbound). Mockamos client para interceptar envios
// reais e verificar que o recovery NÃO re-envia.
vi.mock("@/lib/whatsapp/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/whatsapp/client")>();
  return {
    ...mod,
    sendText: (...args: unknown[]) => sendTextMock(...args),
  };
});

let thinkCount = 0;
vi.mock("@/lib/ai/brain", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ai/brain")>();
  return {
    ...mod,
    think: vi.fn(async (_wa: unknown, _est: unknown, input: { prospectingContext?: { status?: string } }, _options: unknown) => {
      thinkCount++;
      return {
        replyToSend: "Resposta do Mock",
        shouldHandoff: false,
        prospectingStatusTransition: input.prospectingContext?.status === "WAITING_REPLY" ? undefined : "REVEALED",
        toolsCalled: []
      };
    })
  };
});

function createRequest(body: Record<string, unknown>): NextRequest {
  const payload = JSON.stringify(body);
  const signature = "sha256=" + createHmac("sha256", WHATSAPP_TOKEN).update(payload).digest("hex");
  return new NextRequest("http://localhost/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
    body: payload,
  });
}

function buildMetaPayload(waMessageId: string, phone: string, text: string) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "123",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "11999999999", phone_number_id: "[redacted]" },
          contacts: [{ profile: { name: "Test" }, wa_id: phone }],
          messages: [{ from: phone, id: waMessageId, timestamp: "1234567890", text: { body: text }, type: "text" }]
        }
      }]
    }]
  };
}

beforeEach(() => {
  fakeDb.reset();
  process.env.META_APP_SECRET = WHATSAPP_TOKEN;
  vi.clearAllMocks();
  thinkCount = 0;

  fakeDb.col("establishments").set(EST_ID, {
    id: EST_ID,
    bot: { name: "Livia", bookingEnabled: false },
    whatsapp: { status: "connected", phoneNumberId: "[redacted]" },
    secrets: { waToken: "wa-token" }
  });
});

describe("Prospeccao Assistida - Crash Recovery", () => {
  it("1. A. REVEAL - outbound de revelacao confirmado + crash antes de REVEALED; recovery aplica REVEALED sem chamar IA e envios", async () => {
    await upsertProspectingSession(EST_ID, { phone: "5511999990001", leadId: "lead1", businessName: "Biz", segment: "Seg", initialManualMessage: "Oi" });
    const sess = fakeDb.col("establishments/" + EST_ID + "/prospectingSessions").get("5511999990001");
    expect(sess).toBeDefined();
    sess!.status = "LIVIA_ACTIVE"; // Forca active para simular revelacao

    // Simula que o Outbound ja esta confirmed no banco!
    fakeDb.col("_wa_outbound_intents").set("wamid.inbound.crash1", {
      id: "wamid.inbound.crash1",
      state: "confirmed",
      waMessageId: "wamid.mock.123",
      text: "Resposta do Mock",
      prospectingAction: { action: "reveal" },
      createdAt: Date.now()
    });

    const req = createRequest(buildMetaPayload("wamid.inbound.crash1", "5511999990001", "Qual o preco?"));
    const res = await POST(req);
    expect(res.status).toBe(200);

    const s = fakeDb.col("establishments/" + EST_ID + "/prospectingSessions").get("5511999990001");
    expect(s).toBeDefined();
    expect(s!.status).toBe("REVEALED");
    expect(thinkCount).toBe(0);
    expect(sendTextMock).toHaveBeenCalledTimes(0);

    // B. segundo recovery continua sem regressao
    const req2 = createRequest(buildMetaPayload("wamid.inbound.crash1", "5511999990001", "Qual o preco?"));
    await POST(req2);
    expect(thinkCount).toBe(0);
    expect(sendTextMock).toHaveBeenCalledTimes(0);
  });

  it("2. B. PRE-REVEAL - recovery aplica preRevealReplyCount 0 -> 1", async () => {
    await upsertProspectingSession(EST_ID, { phone: "5511999990002", leadId: "lead2", businessName: "Biz", segment: "Seg", initialManualMessage: "Oi" });
    const sess = fakeDb.col("establishments/" + EST_ID + "/prospectingSessions").get("5511999990002");
    expect(sess).toBeDefined();
    sess!.status = "LIVIA_ACTIVE";

    fakeDb.col("_wa_outbound_intents").set("wamid.inbound.crash2", {
      id: "wamid.inbound.crash2",
      state: "confirmed",
      waMessageId: "wamid.mock.123",
      text: "Resposta do Mock",
      prospectingAction: { action: "increment_pre_reveal" },
      createdAt: Date.now()
    });

    const req = createRequest(buildMetaPayload("wamid.inbound.crash2", "5511999990002", "Nao entendi"));
    const res = await POST(req);
    expect(res.status).toBe(200);

    const s = fakeDb.col("establishments/" + EST_ID + "/prospectingSessions").get("5511999990002");
    expect(s).toBeDefined();
    expect(s!.preRevealReplyCount).toBe(1);
    expect(s!.lastPreRevealJobId).toBe("wamid.inbound.crash2");
    expect(thinkCount).toBe(0);

    // retry recovery
    await POST(createRequest(buildMetaPayload("wamid.inbound.crash2", "5511999990002", "Nao entendi")));
    const s2 = fakeDb.col("establishments/" + EST_ID + "/prospectingSessions").get("5511999990002");
    expect(s2).toBeDefined();
    expect(s2!.preRevealReplyCount).toBe(1); // continua 1
  });

  it("3. C. FALHA ANTES DA ENTREGA - falha antes de confirmed nao marca REVEALED nem incrementa", async () => {
    await upsertProspectingSession(EST_ID, { phone: "5511999990003", leadId: "lead3", businessName: "Biz", segment: "Seg", initialManualMessage: "Oi" });
    const sess = fakeDb.col("establishments/" + EST_ID + "/prospectingSessions").get("5511999990003");
    expect(sess).toBeDefined();
    sess!.status = "LIVIA_ACTIVE";

    fakeDb.col("_wa_outbound_intents").set("wamid.inbound.crash3", {
      id: "wamid.inbound.crash3",
      state: "pending", // Pendente, falhou
      prospectingAction: { action: "reveal" },
      createdAt: Date.now()
    });

    const req = createRequest(buildMetaPayload("wamid.inbound.crash3", "5511999990003", "Oi"));
    await POST(req);

    const s = fakeDb.col("establishments/" + EST_ID + "/prospectingSessions").get("5511999990003");
    expect(s).toBeDefined();
    expect(s!.status).toBe("LIVIA_ACTIVE"); // Nao virou REVEALED
  });
});
