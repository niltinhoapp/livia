import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveEstablishmentId = vi.fn();
const getEstablishment = vi.fn();
const prepareCampaignAudience = vi.fn();
const listMessageTemplates = vi.fn();
vi.mock("@/lib/auth/session", () => ({ resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args) }));
vi.mock("@/lib/repo", () => ({
  getEstablishment: (...args: unknown[]) => getEstablishment(...args),
  prepareCampaignAudience: (...args: unknown[]) => prepareCampaignAudience(...args),
}));
vi.mock("@/lib/whatsapp/client", () => ({
  listMessageTemplates: (...args: unknown[]) => listMessageTemplates(...args),
  WhatsAppTemplateError: class WhatsAppTemplateError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } },
}));

const { POST } = await import("./route");
const whatsapp = { status: "connected", wabaId: "waba-a" };
const metaTemplate = { id: "tpl-1", name: "hello", language: "pt_BR", status: "APPROVED", components: [], approved: true, senderCompatible: true };

function request(template: unknown) {
  return new NextRequest("https://example.test/api/campaigns/c1/audience", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ selection: "all_eligible", template }),
  });
}

describe("POST /api/campaigns/:id/audience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEstablishmentId.mockResolvedValue("est-a");
    getEstablishment.mockResolvedValue({ id: "est-a", whatsapp });
    listMessageTemplates.mockResolvedValue([metaTemplate]);
    prepareCampaignAudience.mockResolvedValue({ selected: 1, eligible: 1, excluded: 0, recipientsCreated: 1 });
  });

  it("materializa somente o template revalidado pela Meta para o tenant da sessão", async () => {
    const response = await POST(request({ id: "tpl-1", name: "hello", languageCode: "pt_BR", status: "PENDING", senderCompatible: false }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(200);
    expect(listMessageTemplates).toHaveBeenCalledWith(whatsapp, "est-a");
    expect(prepareCampaignAudience).toHaveBeenCalledWith("est-a", "c1", expect.objectContaining({
      selection: "all_eligible",
      template: expect.objectContaining({ id: "tpl-1", status: "APPROVED", senderCompatible: true }),
    }));
  });

  it("rejeita template inexistente ou incompatível sem materializar recipients", async () => {
    listMessageTemplates.mockResolvedValue([]);
    const response = await POST(request({ id: "forged", name: "forged", languageCode: "pt_BR" }), { params: Promise.resolve({ id: "c1" }) });
    expect(response.status).toBe(409);
    expect(prepareCampaignAudience).not.toHaveBeenCalled();
  });
});
