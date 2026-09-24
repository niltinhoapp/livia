import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WhatsAppInboundJob } from "@/types";

const mocks = vi.hoisted(() => ({
  listRecoverableWhatsAppInboundJobs: vi.fn(),
  deleteExpiredWhatsAppProcessedMarkers: vi.fn(),
  drainConversationInbox: vi.fn(),
}));

vi.mock("@/lib/repo", () => ({
  listRecoverableWhatsAppInboundJobs: mocks.listRecoverableWhatsAppInboundJobs,
  deleteExpiredWhatsAppProcessedMarkers: mocks.deleteExpiredWhatsAppProcessedMarkers,
}));

vi.mock("@/app/api/webhooks/whatsapp/route", () => ({
  drainConversationInbox: mocks.drainConversationInbox,
}));

import { GET } from "@/app/api/cron/whatsapp-inbound-recovery/route";

const request = (secret = "cron-test") => new NextRequest("https://example.test/api/cron/whatsapp-inbound-recovery", {
  headers: { authorization: `Bearer ${secret}` },
});

const job = (id: string, conversationId: string, receivedAt: number): WhatsAppInboundJob => ({
  id,
  establishmentId: "est-1",
  conversationId,
  conversationKey: `est-1:${conversationId}`,
  sequence: receivedAt,
  receivedAt,
  whatsappPhoneNumberId: "phone-number-id",
  attempts: 0,
  nextAttemptAt: receivedAt,
  value: { metadata: { phone_number_id: "phone-number-id" }, contacts: [{ wa_id: conversationId }] },
  message: { id, from: conversationId, type: "text", text: { body: id } },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-test");
  mocks.listRecoverableWhatsAppInboundJobs.mockResolvedValue([]);
  mocks.drainConversationInbox.mockResolvedValue(undefined);
  mocks.deleteExpiredWhatsAppProcessedMarkers.mockResolvedValue(0);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recovery cron do inbox inbound", () => {
  it("rejeita chamada sem o bearer configurado", async () => {
    const response = await GET(request("errado"));

    expect(response.status).toBe(401);
    expect(mocks.listRecoverableWhatsAppInboundJobs).not.toHaveBeenCalled();
  });

  it("aciona um drain direto por conversa usando a identidade durável do job", async () => {
    mocks.listRecoverableWhatsAppInboundJobs.mockResolvedValue([
      job("wamid.a1", "551100000001", 1),
      job("wamid.a2", "551100000001", 2),
      job("wamid.b1", "551100000002", 3),
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ conversations: 2, succeeded: 2, failed: 0, expiredMarkersDeleted: 0 });
    expect(mocks.listRecoverableWhatsAppInboundJobs).toHaveBeenCalledWith(100);
    expect(mocks.drainConversationInbox).toHaveBeenCalledTimes(2);
    expect(mocks.drainConversationInbox).toHaveBeenCalledWith("est-1", "551100000001");
    expect(mocks.drainConversationInbox).toHaveBeenCalledWith("est-1", "551100000002");
  });
});
