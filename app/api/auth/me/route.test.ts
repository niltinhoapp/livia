import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifySessionCookie = vi.fn();
const getUser = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifySessionCookie, getUser }),
}));
vi.mock("@/lib/firebase/admin", () => ({
  firebaseAdminApp: {},
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me", () => {
  it("returns user data for valid session", async () => {
    verifySessionCookie.mockResolvedValue({ uid: "u1" });
    getUser.mockResolvedValue({
      uid: "u1",
      displayName: "João",
      email: "joao@test.com",
      photoURL: "https://photo.test/joao.jpg",
    });

    const req = new NextRequest("https://livia.test/api/auth/me", {
      headers: { cookie: "livia_session=valid" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({
      name: "João",
      email: "joao@test.com",
      photo: "https://photo.test/joao.jpg",
    });
  });

  it("returns 401 without session cookie", async () => {
    const req = new NextRequest("https://livia.test/api/auth/me");
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.user).toBeNull();
  });

  it("returns 401 for invalid session", async () => {
    verifySessionCookie.mockRejectedValue(new Error("invalid"));

    const req = new NextRequest("https://livia.test/api/auth/me", {
      headers: { cookie: "livia_session=bad" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.user).toBeNull();
  });

  it("handles user without display name or photo", async () => {
    verifySessionCookie.mockResolvedValue({ uid: "u2" });
    getUser.mockResolvedValue({
      uid: "u2",
      email: "anon@test.com",
    });

    const req = new NextRequest("https://livia.test/api/auth/me", {
      headers: { cookie: "livia_session=valid" },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.user).toEqual({
      name: null,
      email: "anon@test.com",
      photo: null,
    });
  });
});
