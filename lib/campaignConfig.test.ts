import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignsMaxRecipientsPerCampaign, campaignsSendEnabled } from "@/lib/campaignConfig";

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

  it("libera até 100 destinatários por campanha durante o trial", () => {
    expect(campaignsMaxRecipientsPerCampaign({
      billing: { billingStatus: "trial", trialEndsAt: Date.now() + 60_000, updatedAt: Date.now() },
    })).toBe(100);
  });

  it("usa o teto técnico de 200 após ativação", () => {
    expect(campaignsMaxRecipientsPerCampaign({
      billing: { billingStatus: "active", updatedAt: Date.now() },
    })).toBe(200);
  });

  it("mantém contas legadas sem billing no teto técnico", () => {
    expect(campaignsMaxRecipientsPerCampaign()).toBe(200);
  });
});
