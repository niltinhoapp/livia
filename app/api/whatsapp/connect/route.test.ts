// Integração da rota de conexão sem Firebase ou Meta reais. Os dublês
// permitem verificar a ordem e os efeitos do fluxo Cloud API/Coexistence.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveEstablishmentId = vi.fn();
const claimWhatsappConnection = vi.fn();
const finalizeWhatsappConnection = vi.fn();
const releaseWhatsappConnectionAttempt = vi.fn();
const exchangeCodeForToken = vi.fn();
const getWabaPhoneNumbers = vi.fn();
const subscribeAppToWaba = vi.fn();
const registerPhoneNumber = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: (...a: unknown[]) => resolveEstablishmentId(...a),
}));
vi.mock("@/lib/repo", () => ({
  getEstablishment: vi.fn(),
  claimWhatsappConnection: (...a: unknown[]) => claimWhatsappConnection(...a),
  finalizeWhatsappConnection: (...a: unknown[]) => finalizeWhatsappConnection(...a),
  releaseWhatsappConnectionAttempt: (...a: unknown[]) => releaseWhatsappConnectionAttempt(...a),
}));
vi.mock("@/lib/whatsapp/embedded", () => ({
  exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a),
  getWabaPhoneNumbers: (...a: unknown[]) => getWabaPhoneNumbers(...a),
  subscribeAppToWaba: (...a: unknown[]) => subscribeAppToWaba(...a),
  registerPhoneNumber: (...a: unknown[]) => registerPhoneNumber(...a),
  graphErrorOf: vi.fn(() => undefined),
}));
vi.mock("@/lib/whatsapp/tokenCrypto", () => ({
  encryptToken: (token: string) => ({ ciphertext: `encrypted:${token}`, iv: "iv", authTag: "tag" }),
}));
const { POST } = await import("@/app/api/whatsapp/connect/route");

const ESTABLISHMENT_ID = "est_1";
const WABA_ID = "123456";
const PHONE_NUMBER_ID = "987654";
const ATTEMPT_ID = "attempt_1";
const PIN = "123456";
const TOKEN = "meta-business-token";

function request(overrides: Record<string, unknown> = {}) {
  return new Request("https://livia.test/api/whatsapp/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "oauth-code", wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID, ...overrides }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveEstablishmentId.mockResolvedValue(ESTABLISHMENT_ID);
  claimWhatsappConnection.mockResolvedValue({ outcome: "claimed", pin: PIN, attemptId: ATTEMPT_ID });
  exchangeCodeForToken.mockResolvedValue(TOKEN);
  getWabaPhoneNumbers.mockResolvedValue([PHONE_NUMBER_ID]);
  subscribeAppToWaba.mockResolvedValue(undefined);
  registerPhoneNumber.mockResolvedValue({ registered: true });
  finalizeWhatsappConnection.mockResolvedValue({ ok: true });
  releaseWhatsappConnectionAttempt.mockResolvedValue(undefined);
});

describe("POST /api/whatsapp/connect — Cloud API", () => {
  it("troca code, valida posse, inscreve, registra e finaliza no modo padrão", async () => {
    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: true, connectionMode: "cloud_api" });
    expect(exchangeCodeForToken).toHaveBeenCalledWith("oauth-code");
    expect(getWabaPhoneNumbers).toHaveBeenCalledWith(WABA_ID, TOKEN);
    expect(subscribeAppToWaba).toHaveBeenCalledWith(WABA_ID, TOKEN);
    expect(registerPhoneNumber).toHaveBeenCalledWith(PHONE_NUMBER_ID, TOKEN, PIN);
    expect(finalizeWhatsappConnection).toHaveBeenCalledWith(
      ESTABLISHMENT_ID,
      ATTEMPT_ID,
      expect.objectContaining({
        wabaId: WABA_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        connectionMode: "cloud_api",
        accessToken: expect.any(Object),
        registeredAt: expect.any(Number),
      }),
    );
  });

  it("reconexão Cloud API reutiliza o PIN retornado pela claim", async () => {
    claimWhatsappConnection.mockResolvedValueOnce({ outcome: "reconnected", pin: "pin-anterior", attemptId: ATTEMPT_ID });

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(registerPhoneNumber).toHaveBeenCalledWith(PHONE_NUMBER_ID, TOKEN, "pin-anterior");
  });

  it("erro no /register aborta e libera a tentativa", async () => {
    const silentError = vi.spyOn(console, "error").mockImplementation(() => {});
    registerPhoneNumber.mockRejectedValueOnce(new Error("Graph failed"));

    const response = await POST(request() as never);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "REGISTER_FAILED" });
    expect(releaseWhatsappConnectionAttempt).toHaveBeenCalledWith(ESTABLISHMENT_ID, ATTEMPT_ID);
    expect(finalizeWhatsappConnection).not.toHaveBeenCalled();
    silentError.mockRestore();
  });
});

describe("POST /api/whatsapp/connect — Coexistence", () => {
  it("executa OAuth, ownership e subscribe, mas nunca chama /register", async () => {
    const response = await POST(request({ connectionMode: "coexistence" }) as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: true, connectionMode: "coexistence" });
    expect(exchangeCodeForToken).toHaveBeenCalledWith("oauth-code");
    expect(getWabaPhoneNumbers).toHaveBeenCalledWith(WABA_ID, TOKEN);
    expect(subscribeAppToWaba).toHaveBeenCalledWith(WABA_ID, TOKEN);
    expect(registerPhoneNumber).not.toHaveBeenCalled();
    expect(finalizeWhatsappConnection).toHaveBeenCalledWith(
      ESTABLISHMENT_ID,
      ATTEMPT_ID,
      expect.objectContaining({ connectionMode: "coexistence", registeredAt: undefined }),
    );
  });

  it("falha de finalização não confirma conexão parcialmente persistida", async () => {
    const silentError = vi.spyOn(console, "error").mockImplementation(() => {});
    finalizeWhatsappConnection.mockRejectedValueOnce(new Error("Firestore transaction failed"));

    const response = await POST(request({ connectionMode: "coexistence" }) as never);

    // `connectionMode` agora compõe a mesma operação de finalize: se ela falha,
    // não existe um segundo update de modo e a rota não declara sucesso.
    expect(response.status).toBe(500);
    expect(finalizeWhatsappConnection).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect(releaseWhatsappConnectionAttempt).toHaveBeenCalledWith(ESTABLISHMENT_ID, ATTEMPT_ID);
    silentError.mockRestore();
  });
});

describe("POST /api/whatsapp/connect — ownership, lease e abort", () => {
  it("rejeita phoneNumberId fora da WABA e libera a claim sem conectar", async () => {
    const silentError = vi.spyOn(console, "error").mockImplementation(() => {});
    getWabaPhoneNumbers.mockResolvedValueOnce(["outro-numero"]);

    const response = await POST(request() as never);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "OWNERSHIP_MISMATCH" });
    expect(subscribeAppToWaba).not.toHaveBeenCalled();
    expect(registerPhoneNumber).not.toHaveBeenCalled();
    expect(finalizeWhatsappConnection).not.toHaveBeenCalled();
    expect(releaseWhatsappConnectionAttempt).toHaveBeenCalledWith(ESTABLISHMENT_ID, ATTEMPT_ID);
    silentError.mockRestore();
  });

  it("rejeita número conectado por outro tenant antes de trocar OAuth code", async () => {
    const silentError = vi.spyOn(console, "error").mockImplementation(() => {});
    claimWhatsappConnection.mockResolvedValueOnce({ outcome: "number_in_use" });

    const response = await POST(request() as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "NUMBER_IN_USE" });
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
    expect(releaseWhatsappConnectionAttempt).not.toHaveBeenCalled();
    silentError.mockRestore();
  });

  it("não persiste modo quando a lease é perdida antes da finalização", async () => {
    const silentError = vi.spyOn(console, "error").mockImplementation(() => {});
    finalizeWhatsappConnection.mockResolvedValueOnce({ ok: false });

    const response = await POST(request() as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "STALE_ATTEMPT" });
    expect(releaseWhatsappConnectionAttempt).not.toHaveBeenCalled();
    silentError.mockRestore();
  });

  it("duas tentativas concorrentes deixam só uma avançar além da lease", async () => {
    claimWhatsappConnection
      .mockResolvedValueOnce({ outcome: "claimed", pin: PIN, attemptId: ATTEMPT_ID })
      .mockResolvedValueOnce({ outcome: "conflict" });

    const [first, second] = await Promise.all([POST(request() as never), POST(request() as never)]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(finalizeWhatsappConnection).toHaveBeenCalledTimes(1);
  });

  it("falha de OAuth aborta e libera a tentativa sem subscribe, register ou finalize", async () => {
    const silentError = vi.spyOn(console, "error").mockImplementation(() => {});
    exchangeCodeForToken.mockRejectedValueOnce(new Error("invalid code"));

    const response = await POST(request() as never);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "EXCHANGE_FAILED" });
    expect(releaseWhatsappConnectionAttempt).toHaveBeenCalledWith(ESTABLISHMENT_ID, ATTEMPT_ID);
    expect(subscribeAppToWaba).not.toHaveBeenCalled();
    expect(registerPhoneNumber).not.toHaveBeenCalled();
    expect(finalizeWhatsappConnection).not.toHaveBeenCalled();
    silentError.mockRestore();
  });
});
