import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignsSendEnabled } from "@/lib/campaignConfig";

describe("configuração operacional de campanhas", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("mantém o envio ativo quando a variável não está configurada", () => {
    vi.stubEnv("CAMPAIGNS_SEND_ENABLED", "");
    expect(campaignsSendEnabled()).toBe(true);
  });

  it("preserva o rollback explícito por kill switch", () => {
    vi.stubEnv("CAMPAIGNS_SEND_ENABLED", "false");
    expect(campaignsSendEnabled()).toBe(false);
  });
});
