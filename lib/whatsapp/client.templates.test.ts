import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EstablishmentWhatsapp } from "@/types";

vi.mock("@/lib/whatsapp/tokenCrypto", () => ({ decryptToken: () => "token-secret" }));
vi.mock("@/lib/whatsapp/testCredentials", () => ({ getWhatsappTestCredentials: () => null }));

const { listMessageTemplates } = await import("./client");

const wa = { status: "connected", wabaId: "waba-a", phoneNumberId: "phone-a", accessToken: { ciphertext: "x", iv: "y", authTag: "z" } } as unknown as EstablishmentWhatsapp;

describe("listMessageTemplates", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("normaliza status/componentes e pagina sem expor token", async () => {
    const firstPage = { data: [
        { id: "1", name: "approved_body", language: "pt_BR", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Olá {{1}}" }] },
        { id: "2", name: "pending_header", language: "en_US", status: "PENDING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi" }] },
        { id: "3", name: "static_buttons", language: "pt_BR", status: "REJECTED", components: [{ type: "HEADER", format: "TEXT", text: "Oferta" }, { type: "BODY", text: "Não" }, { type: "FOOTER", text: "Até logo" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Sim" }] }] },
      ], paging: { next: "https://graph.facebook.com/v22.0/waba-a/message_templates?after=next" } };
    const secondPage = { data: [{ id: "4", name: "second", language: "pt_BR", status: "APPROVED", components: [] }] };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(firstPage)))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondPage)));
    const templates = await listMessageTemplates(wa, "est-a");
    expect(templates).toHaveLength(4);
    expect(templates[0]).toMatchObject({ approved: true, senderCompatible: true, category: "UTILITY" });
    expect(templates[1]).toMatchObject({ approved: false, senderCompatible: false });
    expect(templates[2].senderCompatible).toBe(true);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer token-secret" } });
    expect(JSON.stringify(templates)).not.toContain("token-secret");
  });

  it("bloqueia mídia e parâmetros fora do corpo", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: "1", name: "media", language: "pt_BR", status: "APPROVED", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Olá" }] },
      { id: "2", name: "dynamic_url", language: "pt_BR", status: "APPROVED", components: [{ type: "BODY", text: "Olá" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.com/{{1}}" }] }] },
    ] })));

    const templates = await listMessageTemplates(wa, "est-a");

    expect(templates.map((template) => template.senderCompatible)).toEqual([false, false]);
  });

  it("não consulta WABA sem conexão", async () => {
    await expect(listMessageTemplates({ ...wa, status: "disconnected" }, "est-a")).rejects.toMatchObject({ code: "not_connected" });
  });

  it("sanitiza erro Meta e ignora URL de paginação externa", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("erro", { status: 429 }));
    await expect(listMessageTemplates(wa, "est-a")).rejects.toMatchObject({ code: "meta_error", status: 429 });
  });
});
