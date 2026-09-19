// @vitest-environment jsdom
//
// Fase 1 do gating de billing: redirect client-side pra /painel/plano
// quando billingRestricted, reaproveitando o mesmo padrão já usado pro
// guard de onboarding. Prova central: NUNCA redireciona quando já está em
// /painel/plano (ou /painel/onboarding) — é isso que evita o loop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { AppShell } from "./AppShell";

const replace = vi.fn();
let currentPathname = "/painel/campanhas";

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ replace }),
}));

vi.mock("./Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("./Header", () => ({ Header: () => null }));

const shellData = vi.fn();
vi.mock("@/components/hooks/useShellData", () => ({
  useShellData: (...a: unknown[]) => shellData(...a),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  currentPathname = "/painel/campanhas";
});

function baseData(overrides: Partial<{ billingRestricted: boolean; exists: boolean; serviceActive: boolean }> = {}) {
  return {
    name: "Estabelecimento",
    type: "outro" as const,
    exists: true,
    whatsappConnected: true,
    serviceActive: true,
    billingRestricted: false,
    ...overrides,
  };
}

describe("AppShell — gating de billing (Fase 1)", () => {
  it("billingRestricted=true numa página qualquer do painel: redireciona para /painel/plano", async () => {
    shellData.mockReturnValue({ data: baseData({ billingRestricted: true }), loading: false });
    render(<AppShell>conteúdo</AppShell>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/painel/plano"));
  });

  it("billingRestricted=true já em /painel/plano: NUNCA redireciona (evita loop)", async () => {
    currentPathname = "/painel/plano";
    shellData.mockReturnValue({ data: baseData({ billingRestricted: true }), loading: false });
    render(<AppShell>conteúdo</AppShell>);
    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalled();
  });

  it("billingRestricted=true em /painel/onboarding: não redireciona pra plano (guard de onboarding tem prioridade)", async () => {
    currentPathname = "/painel/onboarding";
    shellData.mockReturnValue({ data: baseData({ billingRestricted: true }), loading: false });
    render(<AppShell>conteúdo</AppShell>);
    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalledWith("/painel/plano");
  });

  it("billingRestricted=false: nunca redireciona", async () => {
    shellData.mockReturnValue({ data: baseData({ billingRestricted: false }), loading: false });
    render(<AppShell>conteúdo</AppShell>);
    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalled();
  });

  it("ainda carregando (loading=true): não redireciona com dado parcial/obsoleto", async () => {
    shellData.mockReturnValue({ data: null, loading: true });
    render(<AppShell>conteúdo</AppShell>);
    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalled();
  });

  it("guard de onboarding continua funcionando sem interferência do guard de billing", async () => {
    shellData.mockReturnValue({ data: baseData({ exists: false, billingRestricted: false }), loading: false });
    render(<AppShell>conteúdo</AppShell>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/painel/onboarding"));
  });
});
