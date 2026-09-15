import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requirePlatformAdmin = vi.fn();
const provisionPanelAccess = vi.fn();
const changePanelAccess = vi.fn();

vi.mock("@/lib/auth/platformAdmin", () => ({
  requirePlatformAdmin: (...args: unknown[]) => requirePlatformAdmin(...args),
}));
vi.mock("@/lib/auth/session", () => ({ SESSION_COOKIE_NAME: "livia_session" }));
vi.mock("@/lib/panelAccess", () => ({
  provisionPanelAccess: (...args: unknown[]) => provisionPanelAccess(...args),
  changePanelAccess: (...args: unknown[]) => changePanelAccess(...args),
}));

const { POST } = await import("./route");

function request(body: unknown, cookie = "valid-cookie") {
  return new NextRequest("https://livia.test/api/internal/panel-access", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie: `livia_session=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const grant = {
  action: "grant",
  establishmentId: "tenant-a",
  ownerUid: "owner-a",
  expectedPanelAccess: "blocked",
  requestId: "request-201",
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePlatformAdmin.mockResolvedValue({ status: "authorized", actorUid: "admin-uid" });
  changePanelAccess.mockResolvedValue({
    ok: true,
    establishmentId: "tenant-a",
    panelAccess: "allowed",
    outcome: "updated",
  });
  provisionPanelAccess.mockResolvedValue({
    ok: true,
    establishmentId: "target-uid",
    panelAccess: "allowed",
    outcome: "created",
  });
});

describe("POST /api/internal/panel-access", () => {
  it("exige sessão Firebase", async () => {
    requirePlatformAdmin.mockResolvedValueOnce({ status: "unauthenticated" });
    const response = await POST(request(grant, ""));
    expect(response.status).toBe(401);
    expect(changePanelAccess).not.toHaveBeenCalled();
  });

  it("rejeita usuário autenticado que não é platform admin", async () => {
    requirePlatformAdmin.mockResolvedValueOnce({ status: "forbidden" });
    const response = await POST(request(grant));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FORBIDDEN" });
    expect(changePanelAccess).not.toHaveBeenCalled();
  });

  it("rejeita self-grant mesmo para ator administrativo", async () => {
    const response = await POST(request({ ...grant, ownerUid: "admin-uid" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "SELF_GRANT_FORBIDDEN" });
    expect(changePanelAccess).not.toHaveBeenCalled();
  });

  it("valida payload estritamente e rejeita chaves adicionais", async () => {
    for (const body of [null, {}, { ...grant, extra: true }, { ...grant, expectedPanelAccess: "absent" }]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
    }
    expect(changePanelAccess).not.toHaveBeenCalled();
  });

  it("usa actorUid da sessão, não do payload", async () => {
    const response = await POST(request(grant));
    expect(response.status).toBe(200);
    expect(changePanelAccess).toHaveBeenCalledWith({ ...grant, actorUid: "admin-uid" });
  });

  it("provisiona por UID alvo verificado no serviço", async () => {
    const body = {
      action: "provision",
      targetUid: "target-uid",
      expectedPanelAccess: "absent",
      requestId: "request-202",
    };
    const response = await POST(request(body));
    expect(response.status).toBe(201);
    expect(provisionPanelAccess).toHaveBeenCalledWith({ ...body, actorUid: "admin-uid" });
  });

  it("mapeia conflitos administrativos sem escrita adicional", async () => {
    changePanelAccess.mockResolvedValueOnce({ ok: false, reason: "state_conflict" });
    const response = await POST(request(grant));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "STATE_CONFLICT" });
  });

  it("mapeia UID alvo inexistente sem expor identidade administrativa", async () => {
    provisionPanelAccess.mockResolvedValueOnce({ ok: false, reason: "target_user_not_found" });
    const response = await POST(request({
      action: "provision",
      targetUid: "missing-uid",
      expectedPanelAccess: "absent",
      requestId: "request-203",
    }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "TARGET_USER_NOT_FOUND" });
  });
});
