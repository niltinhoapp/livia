import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifySessionCookie = vi.fn();
const getTenant = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifySessionCookie }),
}));
vi.mock("@/lib/firebase/admin", () => ({
  firebaseAdminApp: {},
  db: {
    collection: () => ({
      where: () => ({
        limit: () => ({ get: () => getTenant() }),
      }),
    }),
  },
}));

const { resolveEstablishmentId, resolvePanelAccess, SESSION_COOKIE_NAME } = await import("./session");

function tenant(id: string, panelAccess?: "allowed" | "blocked") {
  return {
    empty: false,
    docs: [{ id, data: () => ({ ownerUid: "owner", ...(panelAccess !== undefined ? { panelAccess } : {}) }) }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifySessionCookie.mockResolvedValue({ uid: "owner" });
  getTenant.mockResolvedValue(tenant("est-1", "allowed"));
});

describe("panelAccess server-side", () => {
  it("sessão inválida não recebe acesso", async () => {
    verifySessionCookie.mockRejectedValueOnce(new Error("invalid"));

    await expect(resolvePanelAccess("invalid-cookie")).resolves.toEqual({ status: "unauthenticated" });
  });

  it("sessão autenticada com acesso permitido resolve o tenant", async () => {
    await expect(resolvePanelAccess("valid-cookie")).resolves.toEqual({
      status: "allowed",
      establishmentId: "est-1",
      legacy: false,
    });
  });

  it("sessão autenticada com panelAccess bloqueado não resolve tenant para APIs", async () => {
    getTenant.mockResolvedValue(tenant("est-1", "blocked"));
    const req = new NextRequest("https://livia.test/api/dashboard", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=valid-cookie` },
    });

    await expect(resolvePanelAccess("valid-cookie")).resolves.toEqual({ status: "blocked" });
    await expect(resolveEstablishmentId(req)).resolves.toBeNull();
  });

  it("estabelecimento legado vinculado, sem campo, permanece permitido", async () => {
    getTenant.mockResolvedValueOnce(tenant("legacy-est"));

    await expect(resolvePanelAccess("valid-cookie")).resolves.toEqual({
      status: "allowed",
      establishmentId: "legacy-est",
      legacy: true,
    });
  });

  it("conta autenticada sem estabelecimento vinculado não ganha acesso", async () => {
    getTenant.mockResolvedValueOnce({ empty: true, docs: [] });

    await expect(resolvePanelAccess("valid-cookie")).resolves.toEqual({ status: "blocked" });
  });
});
