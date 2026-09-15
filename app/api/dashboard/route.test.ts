import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveEstablishmentId = vi.fn();
const getDashboardMetrics = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args),
}));
vi.mock("@/lib/dashboard", () => ({
  getDashboardMetrics: (...args: unknown[]) => getDashboardMetrics(...args),
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  resolveEstablishmentId.mockResolvedValue("est-1");
  getDashboardMetrics.mockResolvedValue({ total: 1 });
});

describe("GET /api/dashboard", () => {
  it("bloqueia chamada direta quando a fronteira central nega panelAccess", async () => {
    resolveEstablishmentId.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("https://livia.test/api/dashboard"));

    expect(response.status).toBe(401);
    expect(getDashboardMetrics).not.toHaveBeenCalled();
  });

  it("preserva comportamento normal para tenant autorizado", async () => {
    const response = await GET(new NextRequest("https://livia.test/api/dashboard"));

    expect(response.status).toBe(200);
    expect(getDashboardMetrics).toHaveBeenCalledWith("est-1", expect.any(Number), expect.any(Number));
  });
});
