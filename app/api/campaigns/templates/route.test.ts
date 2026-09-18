import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const resolveEstablishmentId = vi.fn();
const getEstablishment = vi.fn();
const listMessageTemplates = vi.fn();
vi.mock("@/lib/auth/session", () => ({ resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args) }));
vi.mock("@/lib/repo", () => ({ getEstablishment: (...args: unknown[]) => getEstablishment(...args) }));
vi.mock("@/lib/whatsapp/client", () => ({
  listMessageTemplates: (...args: unknown[]) => listMessageTemplates(...args),
  WhatsAppTemplateError: class WhatsAppTemplateError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } },
}));

const { GET } = await import("./route");

describe("GET /api/campaigns/templates", () => {
  beforeEach(() => { vi.clearAllMocks(); resolveEstablishmentId.mockResolvedValue("est-a"); });

  it("usa o tenant da sessão e retorna o catálogo normalizado", async () => {
    const whatsapp = { status: "connected", wabaId: "waba-a" };
    getEstablishment.mockResolvedValue({ id: "est-a", whatsapp });
    listMessageTemplates.mockResolvedValue([{ id: "1", name: "hello", language: "pt_BR", status: "APPROVED", components: [], approved: true, senderCompatible: true }]);
    const response = await GET(new NextRequest("https://example.test/api/campaigns/templates?wabaId=waba-b"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ templates: expect.any(Array) });
    expect(getEstablishment).toHaveBeenCalledWith("est-a");
    expect(listMessageTemplates).toHaveBeenCalledWith(whatsapp, "est-a");
    expect(JSON.stringify(body)).not.toContain("token");
  });

  it("não expõe detalhes quando a Meta falha", async () => {
    getEstablishment.mockResolvedValue({ id: "est-a", whatsapp: { status: "connected", wabaId: "waba-a" } });
    listMessageTemplates.mockRejectedValue(new Error("access token leaked"));
    const response = await GET(new NextRequest("https://example.test/api/campaigns/templates"));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "não foi possível consultar os templates" });
  });
});
