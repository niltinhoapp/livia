import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requirePlatformAdmin = vi.fn();
const createSandboxHarnessDependencies = vi.fn();
const executeAsaasSandboxHarness = vi.fn();

vi.mock("@/lib/auth/platformAdmin", () => ({
  requirePlatformAdmin: (...args: unknown[]) => requirePlatformAdmin(...args),
}));
vi.mock("@/lib/auth/session", () => ({ SESSION_COOKIE_NAME: "livia_session" }));
vi.mock("@/lib/billing/asaasSandboxHarness", async () => {
  const actual = await vi.importActual<typeof import("@/lib/billing/asaasSandboxHarness")>(
    "@/lib/billing/asaasSandboxHarness",
  );
  return {
    ...actual,
    createSandboxHarnessDependencies: (...args: unknown[]) => createSandboxHarnessDependencies(...args),
    executeAsaasSandboxHarness: (...args: unknown[]) => executeAsaasSandboxHarness(...args),
  };
});

const { POST } = await import("./route");

const API_KEY = "$aact_hmlg_FAKE_ROUTE_TEST_KEY";

function request(body: unknown, cookie = "valid-cookie") {
  return new NextRequest("https://preview.livia.test/api/internal/billing/asaas-sandbox-test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie: `livia_session=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox");
  vi.stubEnv("ASAAS_API_KEY", API_KEY);
  requirePlatformAdmin.mockResolvedValue({ status: "authorized", actorUid: "platform-admin" });
  createSandboxHarnessDependencies.mockReturnValue({ fake: true });
  executeAsaasSandboxHarness.mockResolvedValue({ ok: true, action: "auth_check", authenticated: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/internal/billing/asaas-sandbox-test", () => {
  it("sem autenticação administrativa bloqueia antes de construir client/chamar Asaas", async () => {
    requirePlatformAdmin.mockResolvedValueOnce({ status: "unauthenticated" });
    const response = await POST(request({ action: "auth_check", confirmSandbox: true }, ""));
    expect(response.status).toBe(401);
    expect(createSandboxHarnessDependencies).not.toHaveBeenCalled();
    expect(executeAsaasSandboxHarness).not.toHaveBeenCalled();
  });

  it("usuário comum bloqueia antes de construir client/chamar Asaas", async () => {
    requirePlatformAdmin.mockResolvedValueOnce({ status: "forbidden" });
    const response = await POST(request({ action: "auth_check", confirmSandbox: true }));
    expect(response.status).toBe(403);
    expect(createSandboxHarnessDependencies).not.toHaveBeenCalled();
    expect(executeAsaasSandboxHarness).not.toHaveBeenCalled();
  });

  it("kill switch bloqueado faz zero chamada externa", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const response = await POST(request({ action: "auth_check", confirmSandbox: true }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "SANDBOX_HARNESS_DISABLED" });
    expect(createSandboxHarnessDependencies).not.toHaveBeenCalled();
    expect(executeAsaasSandboxHarness).not.toHaveBeenCalled();
  });

  it("sem confirmação explícita faz zero chamada externa", async () => {
    const response = await POST(request({ action: "auth_check" }));
    expect(response.status).toBe(400);
    expect(createSandboxHarnessDependencies).not.toHaveBeenCalled();
    expect(executeAsaasSandboxHarness).not.toHaveBeenCalled();
  });

  it("preview autorizado constrói client server-side e executa comando estrito", async () => {
    const command = { action: "auth_check", confirmSandbox: true };
    const response = await POST(request(command));
    expect(response.status).toBe(200);
    expect(createSandboxHarnessDependencies).toHaveBeenCalledWith(API_KEY);
    expect(executeAsaasSandboxHarness).toHaveBeenCalledWith(command, { fake: true });
    expect(await response.json()).toEqual({ ok: true, action: "auth_check", authenticated: true });
  });

  it("nunca inclui API key em erro inesperado", async () => {
    executeAsaasSandboxHarness.mockRejectedValueOnce(new Error(API_KEY));
    const response = await POST(request({ action: "auth_check", confirmSandbox: true }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(API_KEY);
  });
});
