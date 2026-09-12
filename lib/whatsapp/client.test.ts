import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EstablishmentWhatsapp } from "@/types";

vi.mock("@/lib/whatsapp/tokenCrypto", () => ({
  decryptToken: () => "stored-access-token",
}));

const { sendText } = await import("./client");

const wa: EstablishmentWhatsapp = {
  wabaId: "waba",
  phoneNumberId: "stored-phone-number-id",
  status: "connected",
  accessToken: { ciphertext: "x", iv: "y", authTag: "z" },
} as EstablishmentWhatsapp;

const testEnv = {
  WHATSAPP_TEST_PHONE_NUMBER_ID: "test-phone-number-id",
  WHATSAPP_TEST_ESTABLISHMENT_ID: "test-establishment-id",
  WHATSAPP_TEST_ACCESS_TOKEN: "test-access-token",
};

let fetchMock: ReturnType<typeof vi.fn>;

function configureTestCredentials() {
  for (const [key, value] of Object.entries(testEnv)) vi.stubEnv(key, value);
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendText com credenciais de App Review", () => {
  it("em Production ignora as envs de teste e usa a conexão normal", async () => {
    configureTestCredentials();
    vi.stubEnv("VERCEL_ENV", "production");

    await sendText(wa, "test-establishment-id", "5511999999999", "oi");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/stored-phone-number-id/messages");
    expect(init.headers).toMatchObject({ Authorization: "Bearer stored-access-token" });
  });

  it("em Preview mantém o fluxo de teste para o estabelecimento configurado", async () => {
    configureTestCredentials();
    vi.stubEnv("VERCEL_ENV", "preview");

    await sendText(wa, "test-establishment-id", "5511999999999", "oi");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/test-phone-number-id/messages");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-access-token" });
  });

  it("em Preview não usa credenciais de teste para outro estabelecimento", async () => {
    configureTestCredentials();
    vi.stubEnv("VERCEL_ENV", "preview");

    await sendText(wa, "other-establishment-id", "5511999999999", "oi");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/stored-phone-number-id/messages");
    expect(init.headers).toMatchObject({ Authorization: "Bearer stored-access-token" });
  });
});
