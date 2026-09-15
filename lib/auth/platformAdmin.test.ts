import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifySessionCookie = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifySessionCookie }),
}));
vi.mock("@/lib/firebase/admin", () => ({ firebaseAdminApp: {} }));

const { requirePlatformAdmin } = await import("./platformAdmin");
const originalAdminUids = process.env.PANEL_ADMIN_UIDS;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PANEL_ADMIN_UIDS = "admin-uid,second-admin";
  verifySessionCookie.mockResolvedValue({ uid: "admin-uid" });
});

afterEach(() => {
  if (originalAdminUids === undefined) delete process.env.PANEL_ADMIN_UIDS;
  else process.env.PANEL_ADMIN_UIDS = originalAdminUids;
});

describe("requirePlatformAdmin", () => {
  it("autoriza somente o UID vindo da sessão Firebase validada", async () => {
    await expect(requirePlatformAdmin("valid-cookie")).resolves.toEqual({
      status: "authorized",
      actorUid: "admin-uid",
    });
    expect(verifySessionCookie).toHaveBeenCalledWith("valid-cookie", true);
  });

  it("rejeita ausência de cookie", async () => {
    await expect(requirePlatformAdmin(undefined)).resolves.toEqual({ status: "unauthenticated" });
    expect(verifySessionCookie).not.toHaveBeenCalled();
  });

  it("rejeita cookie inválido ou revogado", async () => {
    verifySessionCookie.mockRejectedValueOnce(new Error("revoked"));
    await expect(requirePlatformAdmin("invalid-cookie")).resolves.toEqual({ status: "unauthenticated" });
  });

  it("falha fechado quando PANEL_ADMIN_UIDS está ausente, vazia ou inválida", async () => {
    for (const value of [undefined, "", "admin-uid,,second-admin", "uid com espaço"]) {
      if (value === undefined) delete process.env.PANEL_ADMIN_UIDS;
      else process.env.PANEL_ADMIN_UIDS = value;
      await expect(requirePlatformAdmin("valid-cookie")).resolves.toEqual({ status: "forbidden" });
    }
  });

  it("não transforma usuário com sessão válida em platform admin", async () => {
    verifySessionCookie.mockResolvedValueOnce({ uid: "ordinary-owner" });
    await expect(requirePlatformAdmin("valid-cookie")).resolves.toEqual({ status: "forbidden" });
  });
});
