import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveAdminAccess } from "./adminSession";
import { getAuth } from "firebase-admin/auth";

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  firebaseAdminApp: {},
}));

describe("resolveAdminAccess", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetAllMocks();
  });

  const mockVerify = (uid?: string) => {
    if (uid) {
      vi.mocked(getAuth).mockReturnValue({
        verifySessionCookie: vi.fn().mockResolvedValue({ uid }),
      } as any);
    } else {
      vi.mocked(getAuth).mockReturnValue({
        verifySessionCookie: vi.fn().mockRejectedValue(new Error("invalid cookie")),
      } as any);
    }
  };

  it("returns unauthenticated se não houver cookie", async () => {
    const res = await resolveAdminAccess(undefined);
    expect(res.status).toBe("unauthenticated");
  });

  it("returns unauthenticated se a sessão for inválida", async () => {
    mockVerify();
    const res = await resolveAdminAccess("bad_cookie");
    expect(res.status).toBe("unauthenticated");
  });

  it("returns blocked se a variável CONECTWEB_ADMIN_UIDS estiver ausente", async () => {
    mockVerify("user123");
    delete process.env.CONECTWEB_ADMIN_UIDS;
    const res = await resolveAdminAccess("valid_cookie");
    expect(res.status).toBe("blocked");
  });

  it("returns blocked se a variável CONECTWEB_ADMIN_UIDS estiver vazia", async () => {
    mockVerify("user123");
    process.env.CONECTWEB_ADMIN_UIDS = "   ";
    const res = await resolveAdminAccess("valid_cookie");
    expect(res.status).toBe("blocked");
  });

  it("returns allowed para um admin autorizado", async () => {
    mockVerify("admin123");
    process.env.CONECTWEB_ADMIN_UIDS = "admin123,other456";
    const res = await resolveAdminAccess("valid_cookie");
    expect(res.status).toBe("allowed");
    if (res.status === "allowed") expect(res.uid).toBe("admin123");
  });

  it("returns blocked para usuário autenticado mas não autorizado", async () => {
    mockVerify("user123");
    process.env.CONECTWEB_ADMIN_UIDS = "admin123,other456";
    const res = await resolveAdminAccess("valid_cookie");
    expect(res.status).toBe("blocked");
  });

  it("processa espaços e múltiplos UIDs corretamente", async () => {
    mockVerify("admin456");
    process.env.CONECTWEB_ADMIN_UIDS = " admin123 ,  , admin456  ,";
    const res = await resolveAdminAccess("valid_cookie");
    expect(res.status).toBe("allowed");
    if (res.status === "allowed") expect(res.uid).toBe("admin456");
  });
});
