// @vitest-environment jsdom
//
// OT-07D: cobre só o delta client-ready (trial real / billing ausente /
// loading / erro) — segue o mesmo padrão de mock de fetch de
// app/painel/conversas/page.messages.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import PlanoPage from "./page";
import type { Establishment } from "@/types";

function establishment(over: Partial<Establishment> = {}): Establishment {
  return {
    id: "est-1",
    name: "Estabelecimento",
    type: "outro",
    ownerUid: "est-1",
    status: "active",
    createdAt: 1,
    bot: {
      personaName: "Livia",
      tone: "acolhedora",
      bookingEnabled: false,
      handoffKeywords: [],
      medicalGuardrail: false,
    },
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchOnce(body: unknown, ok = true) {
  fetchMock = vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response));
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PlanoPage (OT-07D)", () => {
  it("trial ativo: mostra badge de período de teste e dias restantes, sem billingStatus cru", async () => {
    const trialEndsAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
    mockFetchOnce({
      establishment: establishment({
        billing: { billingStatus: "trial", trialStartAt: Date.now(), trialEndsAt, updatedAt: 1 },
      }),
      exists: true,
    });
    render(<PlanoPage />);

    expect(await screen.findByText("Período de teste")).toBeTruthy();
    expect(screen.getByText(/dias restantes|dia restante/)).toBeTruthy();
    expect(screen.queryByText(/^trial$/i)).toBeNull();
  });

  it("billing ausente (establishment legado): não quebra, mostra plano sem badge de trial", async () => {
    mockFetchOnce({ establishment: establishment(), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByText("Lívia")).toBeTruthy();
    expect(screen.queryByText("Período de teste")).toBeNull();
  });

  it("card do plano mostra R$129/mês e a oferta de 7 dias grátis", async () => {
    mockFetchOnce({ establishment: establishment(), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByText("R$ 129")).toBeTruthy();
    expect(screen.getByText(/7 dias grátis/i)).toBeTruthy();
  });

  it("trial vencido (billingStatus ainda 'trial', trialEndsAt no passado): não aparece como ativo", async () => {
    const trialEndsAt = Date.now() - 24 * 60 * 60 * 1000;
    mockFetchOnce({
      establishment: establishment({
        billing: { billingStatus: "trial", trialStartAt: trialEndsAt - 7 * 24 * 60 * 60 * 1000, trialEndsAt, updatedAt: 1 },
      }),
      exists: true,
    });
    render(<PlanoPage />);

    expect(await screen.findByText("Período de teste encerrado")).toBeTruthy();
    expect(screen.queryByText("Período de teste")).toBeNull();
    expect(screen.queryByText(/0 dias restantes/)).toBeNull();
    expect(screen.queryByText(/dias restantes|dia restante/)).toBeNull();
  });

  it("erro de carregamento: mostra aviso, não quebra a página", async () => {
    mockFetchOnce({}, false);
    render(<PlanoPage />);

    expect(await screen.findByText(/não foi possível carregar/i)).toBeTruthy();
  });

  it("loading: renderiza skeleton antes da resposta", () => {
    fetchMock = vi.fn(() => new Promise(() => {})); // nunca resolve
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<PlanoPage />);
    expect(container.querySelector(".animate-pulse, [class*=skeleton], [class*=Skeleton]")).toBeTruthy();
  });
});
