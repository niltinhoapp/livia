// @vitest-environment jsdom
//
// Fase 1 do gating de billing: billingRestricted (via canUseService, pura —
// não alterada aqui) para cada estado, sem requisição nova (reaproveita o
// GET /api/establishment já existente). serviceActive continua um eixo
// separado — nunca deve mudar junto com billingRestricted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useShellData } from "./useShellData";
import { nextBillingStatus } from "@/lib/billing/stateMachine";
import type { Establishment } from "@/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function establishment(billing?: Establishment["billing"], status: Establishment["status"] = "active") {
  return {
    id: "est-1",
    name: "Estabelecimento",
    type: "outro",
    status,
    billing,
  };
}

function mockFetch(establishmentBody: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const u = String(url);
      if (u.includes("/api/establishment")) {
        return Promise.resolve({ json: () => Promise.resolve(establishmentBody) } as Response);
      }
      if (u.includes("/api/whatsapp/connect")) {
        return Promise.resolve({ json: () => Promise.resolve({ connected: true }) } as Response);
      }
      return Promise.resolve({ json: () => Promise.resolve({}) } as Response);
    }),
  );
}

describe("useShellData — billingRestricted (Fase 1)", () => {
  it("active: painel não fica restrito", async () => {
    mockFetch({ exists: true, establishment: establishment({ billingStatus: "active", updatedAt: 1 }) });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billingRestricted).toBe(false);
  });

  it("past_due: dentro da carência, painel não fica restrito", async () => {
    mockFetch({ exists: true, establishment: establishment({ billingStatus: "past_due", updatedAt: 1 }) });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billingRestricted).toBe(false);
  });

  it("trial dentro da janela: não fica restrito", async () => {
    mockFetch({
      exists: true,
      establishment: establishment({ billingStatus: "trial", trialStartAt: 1, trialEndsAt: Date.now() + 60_000, updatedAt: 1 }),
    });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billingRestricted).toBe(false);
  });

  it("trial vencido HÁ MAIS de 24h (tolerância de regularização esgotada): fica restrito", async () => {
    // Regra definitiva de produto (auditoria pré-primeiro-pagamento real):
    // 24h de tolerância pós-trialEndsAt antes de restringir — ver
    // lib/billing/trialWindow.ts, mesma fonte usada por canUseService.
    mockFetch({
      exists: true,
      establishment: establishment({ billingStatus: "trial", trialStartAt: 1, trialEndsAt: Date.now() - 25 * 3600000, updatedAt: 1 }),
    });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billingRestricted).toBe(true);
  });

  it("trial vencido HÁ POUCO (ainda dentro da tolerância de 24h): NÃO fica restrito", async () => {
    mockFetch({
      exists: true,
      establishment: establishment({ billingStatus: "trial", trialStartAt: 1, trialEndsAt: Date.now() - 60_000, updatedAt: 1 }),
    });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billingRestricted).toBe(false);
  });

  it("suspended: fica restrito", async () => {
    mockFetch({ exists: true, establishment: establishment({ billingStatus: "suspended", suspendedAt: 1, updatedAt: 1 }) });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billingRestricted).toBe(true);
  });

  it("canceled: fica restrito", async () => {
    mockFetch({ exists: true, establishment: establishment({ billingStatus: "canceled", updatedAt: 1 }) });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billingRestricted).toBe(true);
  });

  it("establishment legado (sem billing): não fica restrito", async () => {
    mockFetch({ exists: true, establishment: establishment(undefined) });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billingRestricted).toBe(false);
  });

  it("recuperação automática: suspended -> webhook confirma pagamento -> active -> painel deixa de ficar restrito, sem intervenção manual", async () => {
    // Usa a MESMA função pura que o processamento do webhook Asaas usa de
    // verdade (lib/billing/stateMachine.ts, não reimplementada aqui) para
    // calcular o próximo billingStatus — não fabrica "active" arbitrariamente.
    const transition = nextBillingStatus("suspended", { type: "payment_confirmed" });
    expect(transition.ok).toBe(true);

    mockFetch({
      exists: true,
      establishment: establishment({ billingStatus: transition.ok ? transition.next : "suspended", updatedAt: 1 }),
    });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data?.billingRestricted).toBe(false); // sem nenhuma ação manual além do próprio fetch já existente
  });

  it("billingRestricted é um eixo separado de serviceActive: suspenso por billing não implica serviceActive=false", async () => {
    mockFetch({ exists: true, establishment: establishment({ billingStatus: "suspended", suspendedAt: 1, updatedAt: 1 }, "active") });
    const { result } = renderHook(() => useShellData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.billingRestricted).toBe(true);
    expect(result.current.data?.serviceActive).toBe(true); // Establishment.status continua "active"
  });
});
