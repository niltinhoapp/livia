// markAsRead — sucesso, erro HTTP e falha de rede.
//
// Regressão do caso real de Production (05/09/2026): a Graph API vinha
// devolvendo HTTP 400 nesta chamada e NADA aparecia nos logs, porque o código
// nunca checava res.ok nem lia o corpo — o Response era descartado fechado, e
// o .catch() de então só pegaria falha de rede (um 400 resolve a promise, não
// a rejeita). O diagnóstico só foi possível olhando o painel do Vercel na mão.
//
// O contrato que estes testes fixam: markAsRead continua best-effort (nunca
// lança, nunca bloqueia think()/sendText()), mas a falha vira log com os
// campos de diagnóstico da Meta — e sem token, telefone ou conteúdo.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { EstablishmentWhatsapp } from "@/types";

vi.mock("@/lib/whatsapp/tokenCrypto", () => ({
  decryptToken: () => "TOKEN-SECRETO-NAO-PODE-VAZAR",
}));

const { markAsRead } = await import("./client");

const wa: EstablishmentWhatsapp = {
  wabaId: "waba_1",
  phoneNumberId: "1281198751744796",
  status: "connected",
  accessToken: { ciphertext: "x", iv: "y", authTag: "z" },
} as unknown as EstablishmentWhatsapp;

const MSG_ID = "wamid.HBgNNTUxNDk5NjQ0NzEzMhUCABIYFjNB";

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

function resposta(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe("markAsRead — sucesso", () => {
  it("envia o payload correto e não loga nada quando a Meta aceita", async () => {
    fetchMock.mockResolvedValue(resposta(200, JSON.stringify({ success: true })));

    await expect(markAsRead(wa, "est_odonto", MSG_ID)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v22.0/1281198751744796/messages");
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: MSG_ID,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("markAsRead — erro HTTP da Graph API", () => {
  it("registra status, code, subcode, type, message e fbtrace_id", async () => {
    fetchMock.mockResolvedValue(
      resposta(
        400,
        JSON.stringify({
          error: {
            message: "(#100) The parameter message_id is required.",
            type: "OAuthException",
            code: 100,
            error_subcode: 33,
            fbtrace_id: "AbCdEfGh123",
          },
        }),
      ),
    );

    await markAsRead(wa, "est_odonto", MSG_ID);

    expect(warn).toHaveBeenCalledTimes(1);
    const [prefixo, payload] = warn.mock.calls[0] as [string, string];
    expect(prefixo).toContain("markAsRead falhou");
    expect(JSON.parse(payload)).toEqual({
      status: 400,
      code: 100,
      subcode: 33,
      type: "OAuthException",
      message: "(#100) The parameter message_id is required.",
      fbtraceId: "AbCdEfGh123",
    });
  });

  it("nunca lança — o fluxo de resposta ao cliente não pode ser bloqueado", async () => {
    fetchMock.mockResolvedValue(resposta(400, JSON.stringify({ error: { code: 100 } })));

    await expect(markAsRead(wa, "est_odonto", MSG_ID)).resolves.toBeUndefined();
  });

  it("corpo não-JSON não quebra o log", async () => {
    fetchMock.mockResolvedValue(resposta(502, "<html>Bad Gateway</html>"));

    await markAsRead(wa, "est_odonto", MSG_ID);

    const payload = JSON.parse((warn.mock.calls[0] as [string, string])[1]);
    expect(payload).toMatchObject({ status: 502, parsed: false });
  });

  it("não vaza token, telefone nem conteúdo da mensagem no log", async () => {
    fetchMock.mockResolvedValue(
      resposta(400, JSON.stringify({ error: { message: "erro", code: 100, fbtrace_id: "x" } })),
    );

    await markAsRead(wa, "est_odonto", MSG_ID);

    const logado = (warn.mock.calls[0] as [string, string]).join(" ");
    expect(logado).not.toContain("TOKEN-SECRETO-NAO-PODE-VAZAR");
    expect(logado).not.toContain("Bearer");
    expect(logado).not.toContain("5514996447132");
  });

  it("trunca mensagens longas da Meta", async () => {
    fetchMock.mockResolvedValue(
      resposta(400, JSON.stringify({ error: { message: "x".repeat(500), code: 100 } })),
    );

    await markAsRead(wa, "est_odonto", MSG_ID);

    const payload = JSON.parse((warn.mock.calls[0] as [string, string])[1]);
    expect(payload.message).toHaveLength(200);
  });
});

describe("markAsRead — falha de rede", () => {
  it("não lança e registra o erro de rede", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    await expect(markAsRead(wa, "est_odonto", MSG_ID)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0] as [string, string])[0]).toContain("rede");
  });
});

describe("markAsRead — canal não conectado", () => {
  it("nem chega a chamar a Graph API", async () => {
    const desconectado = { ...wa, status: "disconnected" } as unknown as EstablishmentWhatsapp;

    await expect(markAsRead(desconectado, "est_odonto", MSG_ID)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
