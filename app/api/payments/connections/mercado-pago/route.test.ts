import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, get, begin, disconnect } = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn(), begin: vi.fn(), disconnect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ resolveEstablishmentId: auth }));
vi.mock("@/lib/payments/mercadoPagoOAuth", () => ({ getMercadoPagoConnection: get, beginMercadoPagoOAuth: begin, disconnectMercadoPago: disconnect, PaymentConnectionError: class PaymentConnectionError extends Error { code = "provider_error"; } }));
import { DELETE, GET, POST } from "./route";

beforeEach(() => { vi.clearAllMocks(); auth.mockResolvedValue("est-a"); });
describe("Mercado Pago connection API", () => {
  it("nunca devolve credenciais ao painel", async () => {
    get.mockResolvedValue({ id: "mercado_pago", status: "connected", providerAccountId: "merchant", accessToken: "secret", refreshToken: "secret", refreshLeaseId: "lease", refreshLeaseExpiresAt: 1 });
    const response = await GET(new Request("http://test/api/payments/connections/mercado-pago") as never);
    const body = await response.json(); expect(JSON.stringify(body)).not.toContain("secret"); expect(body.connection).toMatchObject({ status: "connected", providerAccountId: "merchant" }); expect(body.connection).not.toHaveProperty("refreshLeaseId");
  });
  it("deriva tenant da sessão para conectar e desconectar", async () => {
    begin.mockResolvedValue({ authorizationUrl: "https://auth.example" }); disconnect.mockResolvedValue(undefined);
    await expect((await POST(new Request("http://test") as never)).json()).resolves.toEqual({ authorizationUrl: "https://auth.example" });
    await expect((await DELETE(new Request("http://test") as never)).json()).resolves.toEqual({ disconnected: true });
    expect(begin).toHaveBeenCalledWith("est-a"); expect(disconnect).toHaveBeenCalledWith("est-a");
  });
  it("rejeita requisição sem sessão", async () => { auth.mockResolvedValue(null); expect((await GET(new Request("http://test") as never)).status).toBe(401); });
});
