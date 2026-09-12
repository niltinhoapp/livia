import { afterEach, describe, expect, it, vi } from "vitest";
import { getWhatsappTestCredentials } from "./testCredentials";

const testEnv = {
  WHATSAPP_TEST_PHONE_NUMBER_ID: "test-phone-number-id",
  WHATSAPP_TEST_ESTABLISHMENT_ID: "test-establishment-id",
  WHATSAPP_TEST_ACCESS_TOKEN: "test-access-token",
};

function configureTestCredentials() {
  for (const [key, value] of Object.entries(testEnv)) vi.stubEnv(key, value);
}

afterEach(() => vi.unstubAllEnvs());

describe("getWhatsappTestCredentials", () => {
  it("nunca ativa em Production, mesmo com todas as envs configuradas", () => {
    configureTestCredentials();
    vi.stubEnv("VERCEL_ENV", "production");

    expect(getWhatsappTestCredentials()).toBeNull();
  });

  it("ativa em Preview quando as três envs estão presentes", () => {
    configureTestCredentials();
    vi.stubEnv("VERCEL_ENV", "preview");

    expect(getWhatsappTestCredentials()).toEqual({
      phoneNumberId: "test-phone-number-id",
      establishmentId: "test-establishment-id",
      accessToken: "test-access-token",
    });
  });

  it("ativa durante testes sem exigir uma env da Vercel", () => {
    configureTestCredentials();
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "test");

    expect(getWhatsappTestCredentials()).not.toBeNull();
  });

  it("falha fechado em desenvolvimento local ou ambiente desconhecido", () => {
    configureTestCredentials();
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");

    expect(getWhatsappTestCredentials()).toBeNull();
  });

  it.each(Object.keys(testEnv))("não ativa com %s ausente", (missing) => {
    configureTestCredentials();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv(missing, "");

    expect(getWhatsappTestCredentials()).toBeNull();
  });
});
