import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Establishment } from "@/types";

const resolveEstablishmentId = vi.fn();
const getEstablishment = vi.fn();
const upsertEstablishmentConfig = vi.fn();
const defaultBotConfig = vi.fn();

vi.mock("@/lib/auth/session", () => ({ resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args) }));
vi.mock("@/lib/repo", () => ({
  getEstablishment: (...args: unknown[]) => getEstablishment(...args),
  upsertEstablishmentConfig: (...args: unknown[]) => upsertEstablishmentConfig(...args),
  defaultBotConfig: (...args: unknown[]) => defaultBotConfig(...args),
}));

const { GET, PUT } = await import("./route");

const establishment = {
  id: "est_1", name: "Clínica", type: "clinica", ownerUid: "owner_1", status: "active", createdAt: 1,
  bot: { personaName: "Lívia", tone: "acolhedor", bookingEnabled: true, ordersEnabled: false, voiceRepliesEnabled: false, medicalGuardrail: true, handoffKeywords: [] },
  whatsapp: {
    wabaId: "waba_1", phoneNumberId: "phone_1", status: "connected", connectionMode: "cloud_api", connectedAt: 2,
    accessToken: { ciphertext: "ciphertext", iv: "iv", authTag: "tag" },
    pin: { ciphertext: "pin-ciphertext", iv: "iv", authTag: "tag" },
    pinsByPhoneNumberId: { phone_1: { ciphertext: "map-ciphertext", iv: "iv", authTag: "tag" } },
  },
} as Establishment;

beforeEach(() => {
  vi.clearAllMocks();
  resolveEstablishmentId.mockResolvedValue("est_1");
  getEstablishment.mockResolvedValue(establishment);
  upsertEstablishmentConfig.mockResolvedValue(establishment);
  defaultBotConfig.mockReturnValue(establishment.bot);
});

function expectSafeWhatsapp(body: { establishment: Record<string, any> }) {
  expect(body.establishment.whatsapp).toMatchObject({ wabaId: "waba_1", phoneNumberId: "phone_1", status: "connected", connectionMode: "cloud_api", connectedAt: 2 });
  expect(body.establishment.whatsapp).not.toHaveProperty("accessToken");
  expect(body.establishment.whatsapp).not.toHaveProperty("pin");
  expect(body.establishment.whatsapp).not.toHaveProperty("pinsByPhoneNumberId");
}

describe("/api/establishment", () => {
  it("GET remove credenciais do WhatsApp sem mutar o estabelecimento persistido", async () => {
    const response = await GET(new NextRequest("https://example.test/api/establishment"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expectSafeWhatsapp(body);
    expect(establishment.whatsapp?.accessToken).toBeDefined();
    expect(establishment.whatsapp?.pin).toBeDefined();
    expect(establishment.whatsapp?.pinsByPhoneNumberId).toBeDefined();
  });

  it("PUT remove credenciais do WhatsApp da resposta", async () => {
    const response = await PUT(new NextRequest("https://example.test/api/establishment", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Clínica atualizada" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expectSafeWhatsapp(body);
  });

  it("persiste sendTime e preserva o estado técnico do resumo diário", async () => {
    getEstablishment.mockResolvedValueOnce({
      ...establishment,
      dailyOwnerSummary: {
        enabled: true, ownerPhone: "5514999999999", templateName: "resumo_diario",
        templateLang: "pt_BR", sendTime: "18:00", lastSentDate: "2026-09-24",
      },
    });

    await PUT(new NextRequest("https://example.test/api/establishment", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyOwnerSummary: {
        enabled: true, ownerPhone: "(14) 99999-9999", sendTime: "09:30",
        templateName: "não-substituir", templateLang: "en_US",
      } }),
    }));

    expect(upsertEstablishmentConfig).toHaveBeenCalledWith("est_1", expect.objectContaining({
      dailyOwnerSummary: {
        enabled: true, ownerPhone: "14999999999", templateName: "resumo_diario",
        templateLang: "pt_BR", sendTime: "09:30", lastSentDate: "2026-09-24",
      },
    }));
  });

  it("normaliza horário inválido e usa o fallback de idioma quando ainda não há resumo", async () => {
    getEstablishment.mockResolvedValueOnce(establishment);

    await PUT(new NextRequest("https://example.test/api/establishment", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyOwnerSummary: {
        enabled: true, ownerPhone: "5514999999999", sendTime: "25:99", templateName: "resumo_diario", templateLang: "",
      } }),
    }));

    expect(upsertEstablishmentConfig).toHaveBeenCalledWith("est_1", expect.objectContaining({
      dailyOwnerSummary: expect.objectContaining({ templateName: "resumo_diario", templateLang: "pt_BR", sendTime: "18:00" }),
    }));
  });
});
