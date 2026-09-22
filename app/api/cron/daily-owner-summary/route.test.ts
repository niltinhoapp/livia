import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const dbGet = vi.fn();
const getScheduleConfig = vi.fn();
const getDashboardMetrics = vi.fn();
const sendTemplate = vi.fn();
const markDailyOwnerSummarySent = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({ db: { collection: () => ({ where: () => ({ get: () => dbGet() }) }) } }));
vi.mock("@/lib/scheduling", () => ({ getScheduleConfig: (...args: unknown[]) => getScheduleConfig(...args) }));
vi.mock("@/lib/dashboard", () => ({ getDashboardMetrics: (...args: unknown[]) => getDashboardMetrics(...args) }));
vi.mock("@/lib/whatsapp/client", () => ({ sendTemplate: (...args: unknown[]) => sendTemplate(...args) }));
vi.mock("@/lib/repo", () => ({ markDailyOwnerSummarySent: (...args: unknown[]) => markDailyOwnerSummarySent(...args) }));

const { GET } = await import("./route");

function req(headers: Record<string, string> = {}) {
  return new NextRequest("https://example.test/api/cron/daily-owner-summary", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cr3t";
  dbGet.mockResolvedValue({ docs: [], size: 0 });
});

describe("GET /api/cron/daily-owner-summary", () => {
  it.each([
    ["ausente", undefined, {}],
    ["vazio", "", {}],
    ["header ausente", "s3cr3t", {}],
    ["Bearer incorreto", "s3cr3t", { authorization: "Bearer incorreto" }],
  ])("rejeita quando CRON_SECRET está %s sem executar operações", async (_label, secret, headers) => {
    if (secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = secret;

    const response = await GET(req(headers));

    expect(response.status).toBe(401);
    expect(dbGet).not.toHaveBeenCalled();
    expect(getScheduleConfig).not.toHaveBeenCalled();
    expect(getDashboardMetrics).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(markDailyOwnerSummarySent).not.toHaveBeenCalled();
  });

  it("com Bearer correto executa o job", async () => {
    const response = await GET(req({ authorization: "Bearer s3cr3t" }));

    expect(response.status).toBe(200);
    expect(dbGet).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ establishments: 0, sent: 0 });
  });
});
