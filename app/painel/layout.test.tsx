import { beforeEach, describe, expect, it, vi } from "vitest";

const resolvePanelAccess = vi.fn();
const redirect = vi.fn((target: string): never => {
  throw new Error(`redirect:${target}`);
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: "valid-cookie" }) })),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth/session", () => ({
  SESSION_COOKIE_NAME: "livia_session",
  resolvePanelAccess: (...args: unknown[]) => resolvePanelAccess(...args),
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: unknown }) => children,
}));

const PainelLayout = (await import("./layout")).default;

beforeEach(() => {
  vi.clearAllMocks();
  resolvePanelAccess.mockResolvedValue({ status: "allowed", establishmentId: "est-1", legacy: false });
});

describe("layout do painel", () => {
  it("bloqueia URL direta quando panelAccess é negado", async () => {
    resolvePanelAccess.mockResolvedValueOnce({ status: "blocked" });

    await expect(PainelLayout({ children: "conteúdo protegido" })).rejects.toThrow("redirect:/login?access=blocked");
  });

  it("mantém a rota do painel acessível para tenant autorizado", async () => {
    await expect(PainelLayout({ children: "conteúdo protegido" })).resolves.toBeDefined();
    expect(redirect).not.toHaveBeenCalled();
  });
});
