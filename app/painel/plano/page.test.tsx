// @vitest-environment jsdom
//
// OT-07D: cobre só o delta client-ready (trial real / billing ausente /
// loading / erro) — segue o mesmo padrão de mock de fetch de
// app/painel/conversas/page.messages.test.tsx.
// OT-07E2: cobre só o delta de contratação real (CTA -> CPF/CNPJ -> POST
// /api/billing/subscribe -> QR Pix), reaproveitando o mesmo padrão.
// OT de migração pro Hosted Checkout: cobre o delta de cartão (CTA ->
// POST /api/billing/checkout -> redirect) e o retorno via ?checkout=...
// (nunca ativa nada sozinho — só reflete o billingStatus do backend).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Establishment } from "@/types";

// Mesmo padrão de components/layout/AppShell.test.tsx: mocka next/navigation
// com um valor controlável por teste. currentSearchParams é lido por
// useSearchParams().get("checkout") em page.tsx.
let currentSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

const { default: PlanoPage } = await import("./page");

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

// Roteia por URL: GET /api/establishment sempre via `establishment()` (pode
// mudar entre chamadas, para simular o refresh após "Já paguei"/retorno do
// Checkout); POST /api/billing/subscribe via `subscribe(body)`; POST
// /api/billing/checkout via `checkout()`. Usado pelos testes de contratação
// (Pix e cartão) — os testes OT-07D continuam usando mockFetchOnce.
function mockFetchRouter(opts: {
  establishment: () => unknown;
  subscribe?: (body: unknown) => { status: number; body: unknown };
  checkout?: () => { status: number; body: unknown };
}) {
  fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/establishment")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.establishment()) } as Response);
    }
    if (u.includes("/api/billing/subscribe")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = opts.subscribe ? opts.subscribe(body) : { status: 500, body: { error: "UNEXPECTED" } };
      return Promise.resolve({
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: () => Promise.resolve(result.body),
      } as Response);
    }
    if (u.includes("/api/billing/checkout")) {
      const result = opts.checkout ? opts.checkout() : { status: 500, body: { error: "UNEXPECTED" } };
      return Promise.resolve({
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: () => Promise.resolve(result.body),
      } as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function subscribeCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/billing/subscribe"));
}

function checkoutCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/billing/checkout"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  currentSearchParams = new URLSearchParams();
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

  it("card do plano mostra R$129/mês sempre, mesmo sem billing (legado)", async () => {
    mockFetchOnce({ establishment: establishment(), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByText("R$ 129")).toBeTruthy();
  });

  it("card do plano mostra a oferta de 7 dias grátis só enquanto ainda dentro da janela antes do pagamento liberar", async () => {
    const trialEndsAt = Date.now() + 6 * 24 * 3600000; // bem antes de trialEndsAt-24h
    mockFetchOnce({
      establishment: establishment({ billing: { billingStatus: "trial", trialStartAt: Date.now(), trialEndsAt, updatedAt: 1 } }),
      exists: true,
    });
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

  it("suspensa: mostra badge de suspensão, orienta regularizar, mantém o CTA de contratação (fase 1 do gating)", async () => {
    mockFetchOnce({
      establishment: establishment({
        billing: { billingStatus: "suspended", externalSubscriptionId: "sub_1", suspendedAt: Date.now(), updatedAt: 1 },
      }),
      exists: true,
    });
    render(<PlanoPage />);

    expect(await screen.findByText("Assinatura suspensa")).toBeTruthy();
    expect(screen.getByText(/suspensa por falta de pagamento/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /ver cobrança pix pendente/i })).toBeTruthy(); // externalSubscriptionId já existe (sub_1) -> hasPendingSubscription
    expect(screen.queryByText(/assinaturas canceladas/i)).toBeNull();
  });

  it("cancelada: mostra badge de cancelamento, orienta suporte, NÃO mostra o CTA de autoatendimento", async () => {
    mockFetchOnce({
      establishment: establishment({
        billing: { billingStatus: "canceled", externalSubscriptionId: "sub_1", updatedAt: 1 },
      }),
      exists: true,
    });
    render(<PlanoPage />);

    expect(await screen.findByText("Assinatura cancelada")).toBeTruthy();
    expect(screen.getByText(/fale com o suporte da lívia para reativar/i)).toBeTruthy();
    expect(screen.getByText(/assinaturas canceladas não voltam automaticamente/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /contratação em breve|pagar com pix|ver cobrança pix pendente|cartão de crédito/i })).toBeNull();
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

describe("PlanoPage — contratação real via PIX (OT-07E2)", () => {
  it("11) botão de contratação aparece quando billingStatus != active", async () => {
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    render(<PlanoPage />);
    expect(await screen.findByRole("button", { name: /pagar com pix/i })).toBeTruthy();
  });

  it("12) CPF/CNPJ só é solicitado após clicar em contratar, nunca antes", async () => {
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    render(<PlanoPage />);
    await screen.findByRole("button", { name: /pagar com pix/i });
    expect(screen.queryByPlaceholderText("000.000.000-00")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /pagar com pix/i }));
    expect(await screen.findByPlaceholderText("000.000.000-00")).toBeTruthy();
  });

  it("13) loading trava clique duplo: só um POST é disparado mesmo com dois cliques em confirmar", async () => {
    let resolveSubscribe!: (v: { status: number; body: unknown }) => void;
    const pending = new Promise<{ status: number; body: unknown }>((r) => (resolveSubscribe = r));
    mockFetchRouter({
      establishment: () => ({ establishment: establishment(), exists: true }),
      subscribe: () => ({ status: 202, body: { status: "processing" } }), // valor default, sobrescrito abaixo
    });
    // Substitui o handler de subscribe por uma promise controlada manualmente.
    fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/establishment")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ establishment: establishment(), exists: true }) } as Response);
      }
      if (u.includes("/api/billing/subscribe")) {
        return pending.then((r) => ({ ok: r.status < 300, status: r.status, json: () => Promise.resolve(r.body) } as Response));
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
    });

    render(<PlanoPage />);
    fireEvent.click(await screen.findByRole("button", { name: /pagar com pix/i }));
    fireEvent.change(await screen.findByPlaceholderText("000.000.000-00"), { target: { value: "52998224725" } });
    const confirmBtn = screen.getByRole("button", { name: /confirmar contratação/i });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn); // segundo clique enquanto a 1ª requisição ainda está em voo

    resolveSubscribe({ status: 202, body: { status: "processing" } });
    await waitFor(() => expect(screen.getByText(/confirmando sua contratação/i)).toBeTruthy());

    expect(subscribeCalls()).toHaveLength(1);
  });

  it("14) erro é exibido de forma segura, sem CPF/CNPJ digitado", async () => {
    mockFetchRouter({
      establishment: () => ({ establishment: establishment(), exists: true }),
      subscribe: () => ({ status: 400, body: { error: "INVALID_PAYLOAD" } }),
    });
    render(<PlanoPage />);
    fireEvent.click(await screen.findByRole("button", { name: /pagar com pix/i }));
    fireEvent.change(await screen.findByPlaceholderText("000.000.000-00"), { target: { value: "12345678900" } });
    fireEvent.click(screen.getByRole("button", { name: /confirmar contratação/i }));

    const alertText = await screen.findByText(/cpf ou cnpj inválido/i);
    expect(alertText).toBeTruthy();
    expect(screen.queryByText("12345678900")).toBeNull();
    expect(document.body.textContent).not.toContain("INVALID_PAYLOAD");
  });

  it("15) cobrança disponível: mostra QR real e código copia-e-cola", async () => {
    mockFetchRouter({
      establishment: () => ({ establishment: establishment(), exists: true }),
      subscribe: () => ({
        status: 200,
        body: { status: "payment_required", payment: { pixCopyPaste: "00020126copiaecola", qrCode: "BASE64PNGDATA" } },
      }),
    });
    render(<PlanoPage />);
    fireEvent.click(await screen.findByRole("button", { name: /pagar com pix/i }));
    fireEvent.change(await screen.findByPlaceholderText("000.000.000-00"), { target: { value: "52998224725" } });
    fireEvent.click(screen.getByRole("button", { name: /confirmar contratação/i }));

    const img = (await screen.findByAltText(/qr code pix/i)) as HTMLImageElement;
    expect(img.src).toContain("data:image/png;base64,BASE64PNGDATA");
    expect(screen.getByDisplayValue("00020126copiaecola")).toBeTruthy();
  });

  it("16) billingStatus active: não mostra CTA de contratar nem formulário de CPF/CNPJ", async () => {
    mockFetchRouter({
      establishment: () => ({
        establishment: establishment({ billing: { billingStatus: "active", updatedAt: 1 } }),
        exists: true,
      }),
    });
    render(<PlanoPage />);
    expect(await screen.findByText(/assinatura ativa/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pagar com pix/i })).toBeNull();
    expect(screen.queryByPlaceholderText("000.000.000-00")).toBeNull();
  });

  it("17) carregar/renderizar a página nunca dispara POST /api/billing/subscribe sozinho", async () => {
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    render(<PlanoPage />);
    await screen.findByRole("button", { name: /pagar com pix/i });
    expect(subscribeCalls()).toHaveLength(0);
  });
});

describe("PlanoPage — contratação via cartão de crédito (Hosted Checkout)", () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    // jsdom não permite navegação real — substitui por um objeto simples só
    // para capturar a atribuição de href, mesmo padrão usado para testar
    // "window.location.href = ..." sem navegar de verdade.
    // @ts-expect-error apagar window.location é necessário pra poder redefinir abaixo
    delete window.location;
    // @ts-expect-error objeto simplificado, só o suficiente para este teste (href)
    window.location = { href: "" };
  });

  afterEach(() => {
    // @ts-expect-error restaura o location real do jsdom
    window.location = originalLocation;
  });

  it("18) botão de cartão aparece junto do botão de Pix quando billingStatus != active", async () => {
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    render(<PlanoPage />);
    expect(await screen.findByRole("button", { name: /pagar com pix/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cartão de crédito/i })).toBeTruthy();
  });

  it("19) clicar em 'cartão de crédito' chama POST /api/billing/checkout e redireciona para a URL devolvida pelo backend, nunca coleta dado de cartão aqui", async () => {
    mockFetchRouter({
      establishment: () => ({ establishment: establishment(), exists: true }),
      checkout: () => ({ status: 200, body: { status: "checkout_created", checkoutUrl: "https://sandbox.asaas.com/checkoutSession/show/chk_xyz" } }),
    });
    render(<PlanoPage />);
    const btn = await screen.findByRole("button", { name: /cartão de crédito/i });
    fireEvent.click(btn);

    await waitFor(() => expect(window.location.href).toBe("https://sandbox.asaas.com/checkoutSession/show/chk_xyz"));
    expect(checkoutCalls()).toHaveLength(1);
    // Nunca existe campo de número de cartão/CVV nesta página — a coleta
    // acontece exclusivamente na página hospedada da Asaas.
    expect(screen.queryByPlaceholderText(/número do cartão/i)).toBeNull();
  });

  it("20) duplo clique no botão de cartão dispara só uma requisição (trava enquanto redirecionando)", async () => {
    let resolveCheckout!: (v: { status: number; body: unknown }) => void;
    const pending = new Promise<{ status: number; body: unknown }>((r) => (resolveCheckout = r));
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/api/establishment")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ establishment: establishment(), exists: true }) } as Response);
      }
      if (u.includes("/api/billing/checkout")) {
        return pending.then((r) => ({ ok: r.status < 300, status: r.status, json: () => Promise.resolve(r.body) } as Response));
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
    });

    render(<PlanoPage />);
    const btn = await screen.findByRole("button", { name: /cartão de crédito/i });
    fireEvent.click(btn);
    fireEvent.click(btn); // segundo clique enquanto a 1ª requisição ainda está em voo

    resolveCheckout({ status: 200, body: { status: "checkout_created", checkoutUrl: "https://sandbox.asaas.com/x" } });
    await waitFor(() => expect(window.location.href).toBe("https://sandbox.asaas.com/x"));
    expect(checkoutCalls()).toHaveLength(1);
  });

  it("21) retorno ?checkout=success mostra banner de processamento, NUNCA marca a assinatura como ativa a partir da query string", async () => {
    currentSearchParams = new URLSearchParams("checkout=success");
    mockFetchRouter({
      establishment: () => ({ establishment: establishment(), exists: true }), // backend continua "trial" — webhook ainda não confirmou
    });
    render(<PlanoPage />);
    expect(await screen.findByText(/aguardando a confirmação do asaas/i)).toBeTruthy();
    expect(screen.queryByText(/assinatura ativa/i)).toBeNull();
    expect(screen.queryByText(/pagamento confirmado/i)).toBeNull();
  });

  it("22) retorno ?checkout=success quando o webhook JÁ confirmou antes do redirect: reflete active vindo do backend, não do banner", async () => {
    currentSearchParams = new URLSearchParams("checkout=success");
    mockFetchRouter({
      establishment: () => ({
        establishment: establishment({ billing: { billingStatus: "active", updatedAt: 1 } }),
        exists: true,
      }),
    });
    render(<PlanoPage />);
    expect(await screen.findByText(/assinatura ativa/i)).toBeTruthy();
  });

  it("23) retorno ?checkout=cancel nunca mostra o banner de sucesso nem ativa nada", async () => {
    currentSearchParams = new URLSearchParams("checkout=cancel");
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    render(<PlanoPage />);
    expect(await screen.findByText(/cancelado/i)).toBeTruthy();
    expect(screen.queryByText(/aguardando a confirmação/i)).toBeNull();
  });

  it("24) retorno ?checkout=expired orienta a tentar de novo, nunca ativa nada", async () => {
    currentSearchParams = new URLSearchParams("checkout=expired");
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    render(<PlanoPage />);
    expect(await screen.findByText(/link de pagamento expirou/i)).toBeTruthy();
  });

  it("25) erro ao criar Checkout mostra mensagem segura (nunca o texto bruto do backend) e permite tentar de novo", async () => {
    mockFetchRouter({
      establishment: () => ({ establishment: establishment(), exists: true }),
      checkout: () => ({ status: 409, body: { error: "CHECKOUT_CONFLICT", reason: "asaas_rejected" } }),
    });
    render(<PlanoPage />);
    const btn = await screen.findByRole("button", { name: /cartão de crédito/i });
    fireEvent.click(btn);

    expect(await screen.findByText(/não foi possível iniciar o pagamento por cartão/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain("CHECKOUT_CONFLICT");
    expect(document.body.textContent).not.toContain("asaas_rejected");

    const retry = screen.getByRole("button", { name: /tentar novamente/i });
    expect(retry).toBeTruthy();
  });

  it("26) status 202 (processing/busy) do backend nunca redireciona nem trava a página, e nenhum segredo aparece em nenhuma resposta capturada", async () => {
    mockFetchRouter({
      establishment: () => ({ establishment: establishment(), exists: true }),
      checkout: () => ({ status: 202, body: { status: "processing" } }),
    });
    render(<PlanoPage />);
    const btn = await screen.findByRole("button", { name: /cartão de crédito/i });
    fireEvent.click(btn);
    await waitFor(() => expect(checkoutCalls()).toHaveLength(1));
    expect(window.location.href).toBe(""); // nunca navegou
    // Nenhuma chamada de fetch carrega ASAAS_API_KEY/access_token em lugar nenhum.
    for (const call of fetchMock.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/aact_(hmlg|prod)_/i);
    }
  });
});

describe("PlanoPage — janela do trial (regra definitiva de produto)", () => {
  const DAY = 24 * 3600000;

  function trialEstablishment(trialEndsAt: number) {
    return establishment({ billing: { billingStatus: "trial", trialStartAt: trialEndsAt - 7 * DAY, trialEndsAt, updatedAt: 1 } });
  }

  it("antes de trialEndsAt-24h: 'período gratuito está ativo', PIX e cartão OCULTOS", async () => {
    mockFetchOnce({ establishment: trialEstablishment(Date.now() + 6 * DAY), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByText(/período gratuito está ativo/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pagar com pix/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cartão de crédito/i })).toBeNull();
  });

  it("exatamente em trialEndsAt-24h: pagamento liberado (PIX e cartão visíveis)", async () => {
    mockFetchOnce({ establishment: trialEstablishment(Date.now() + DAY), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByRole("button", { name: /pagar com pix/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cartão de crédito/i })).toBeTruthy();
  });

  it("no último dia do trial: 'termina em breve', PIX e cartão visíveis", async () => {
    mockFetchOnce({ establishment: trialEstablishment(Date.now() + 60_000), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByText(/termina em breve/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /pagar com pix/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cartão de crédito/i })).toBeTruthy();
  });

  it("exatamente em trialEndsAt: 'período gratuito terminou', NÃO mostra suspensão, PIX e cartão visíveis", async () => {
    mockFetchOnce({ establishment: trialEstablishment(Date.now()), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByText(/período gratuito terminou/i)).toBeTruthy();
    expect(screen.queryByText(/assinatura suspensa/i)).toBeNull();
    expect(screen.getByRole("button", { name: /pagar com pix/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cartão de crédito/i })).toBeTruthy();
  });

  it("durante as 24h de tolerância: até 24 horas para regularizar, acesso e pagamento disponíveis", async () => {
    mockFetchOnce({ establishment: trialEstablishment(Date.now() - 12 * 3600000), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByText(/até 24 horas para regularizar/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /pagar com pix/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cartão de crédito/i })).toBeTruthy();
  });

  it("1ms antes do fim da tolerância de 24h: ainda não trata como expirado", async () => {
    mockFetchOnce({ establishment: trialEstablishment(Date.now() - DAY + 1000), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByText(/até 24 horas para regularizar/i)).toBeTruthy();
  });

  it("depois de trialEndsAt+24h (billingStatus ainda 'trial', cron ainda não rodou): trata como expirado, pagamento continua disponível", async () => {
    mockFetchOnce({ establishment: trialEstablishment(Date.now() - DAY - 10 * DAY), exists: true });
    render(<PlanoPage />);

    expect(await screen.findByText(/período gratuito terminou\. regularize/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /pagar com pix/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cartão de crédito/i })).toBeTruthy();
  });

  it("billingStatus 'suspended' de verdade (cron já rodou): copy de suspensão existente, PIX e cartão continuam disponíveis", async () => {
    mockFetchOnce({
      establishment: establishment({ billing: { billingStatus: "suspended", externalSubscriptionId: "sub_x", suspendedAt: Date.now(), updatedAt: 1 } }),
      exists: true,
    });
    render(<PlanoPage />);

    expect(await screen.findByText(/assinatura suspensa/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /ver cobrança pix pendente/i })).toBeTruthy(); // externalSubscriptionId já existe -> hasPendingSubscription
    expect(screen.getByRole("button", { name: /cartão de crédito/i })).toBeTruthy();
  });
});
