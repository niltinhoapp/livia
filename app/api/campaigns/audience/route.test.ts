import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolveEstablishmentId = vi.fn();
const previewCampaignAudience = vi.fn();
vi.mock("@/lib/auth/session", () => ({ resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args) }));
vi.mock("@/lib/repo", () => ({ previewCampaignAudience: (...args: unknown[]) => previewCampaignAudience(...args) }));

const { GET } = await import("./route");

describe("GET /api/campaigns/audience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEstablishmentId.mockResolvedValue("est-a");
    previewCampaignAudience.mockResolvedValue({ selected: 3, eligible: 2, excluded: 1 });
  });

  it("usa exclusivamente o tenant resolvido pela sessão", async () => {
    const response = await GET(new NextRequest("https://example.test/api/campaigns/audience?establishmentId=est-b"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ audience: { selected: 3, eligible: 2, excluded: 1 } });
    expect(previewCampaignAudience).toHaveBeenCalledWith("est-a");
  });

  it("exige sessão", async () => {
    resolveEstablishmentId.mockResolvedValue(null);
    const response = await GET(new NextRequest("https://example.test/api/campaigns/audience"));
    expect(response.status).toBe(401);
    expect(previewCampaignAudience).not.toHaveBeenCalled();
  });
});
