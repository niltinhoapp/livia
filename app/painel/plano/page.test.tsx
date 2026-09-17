// @vitest-environment jsdom
//
// OT-07D: cobre só o delta client-ready (trial real / billing ausente /
// loading / erro) — segue o mesmo padrão de mock de fetch de
// app/painel/conversas/page.messages.test.tsx.
// OT-07E2: cobre só o delta de contratação real (CTA -> CPF/CNPJ -> POST
// /api/billing/subscribe -> QR Pix), reaproveitando o mesmo padrão.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// Roteia por URL: GET /api/establishment sempre via `establishment()` (pode
// mudar entre chamadas, para simular o refresh após "Já paguei"); POST
// /api/billing/subscribe via `subscribe(body)`. Usado só pelos testes de
// contratação (OT-07E2) — os testes OT-07D continuam usando mockFetchOnce.
function mockFetchRouter(opts: {
  establishment: () => unknown;
  subscribe?: (body: unknown) => { status: number; body: unknown };
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
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function subscribeCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/billing/subscribe"));
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

describe("PlanoPage — contratação real via PIX (OT-07E2)", () => {
  // OT-BILLING-UI-01: contratação desabilitada SÓ no front
  // (PAYMENT_TEMPORARILY_DISABLED=true em page.tsx) enquanto o Hosted
  // Checkout/Asaas aguarda suporte. O fluxo abaixo (CPF/CNPJ -> POST
  // /api/billing/subscribe -> QR/copia-e-cola) continua intacto no código,
  // só ficou inalcançável pela UI porque o único botão de entrada
  // (id "idle") está `disabled`. Os testes 11/12/17 foram atualizados para
  // essa realidade; 13/14/15 testam estados posteriores do fluxo que hoje
  // não são alcançáveis por clique real — ficam `skip` com este comentário
  // como ponteiro: quando PAYMENT_TEMPORARILY_DISABLED voltar a false,
  // remover o `.skip` e reverter 11/12/17 para as versões que clicam de
  // verdade (git blame deste arquivo antes desta OT tem a versão original).

  it("11) botão de contratação some visível porém desabilitado, com aviso de indisponibilidade temporária", async () => {
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    render(<PlanoPage />);
    const btn = await screen.findByRole("button", { name: /contratação em breve/i });
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/pagamento temporariamente indisponível/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^contratar lívia$/i })).toBeNull();
  });

  it("12) clicar no botão desabilitado nunca revela o formulário de CPF/CNPJ", async () => {
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    render(<PlanoPage />);
    const btn = await screen.findByRole("button", { name: /contratação em breve/i });
    fireEvent.click(btn); // button disabled -> navegador/RTL não dispara onClick
    expect(screen.queryByPlaceholderText("000.000.000-00")).toBeNull();
  });

  it.skip("13) loading trava clique duplo: só um POST é disparado mesmo com dois cliques em confirmar", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: /contratar lívia/i }));
    fireEvent.change(await screen.findByPlaceholderText("000.000.000-00"), { target: { value: "52998224725" } });
    const confirmBtn = screen.getByRole("button", { name: /confirmar contratação/i });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn); // segundo clique enquanto a 1ª requisição ainda está em voo

    resolveSubscribe({ status: 202, body: { status: "processing" } });
    await waitFor(() => expect(screen.getByText(/confirmando sua contratação/i)).toBeTruthy());

    expect(subscribeCalls()).toHaveLength(1);
  });

  it.skip("14) erro é exibido de forma segura, sem CPF/CNPJ digitado", async () => {
    mockFetchRouter({
      establishment: () => ({ establishment: establishment(), exists: true }),
      subscribe: () => ({ status: 400, body: { error: "INVALID_PAYLOAD" } }),
    });
    render(<PlanoPage />);
    fireEvent.click(await screen.findByRole("button", { name: /contratar lívia/i }));
    fireEvent.change(await screen.findByPlaceholderText("000.000.000-00"), { target: { value: "12345678900" } });
    fireEvent.click(screen.getByRole("button", { name: /confirmar contratação/i }));

    const alertText = await screen.findByText(/cpf ou cnpj inválido/i);
    expect(alertText).toBeTruthy();
    expect(screen.queryByText("12345678900")).toBeNull();
    expect(document.body.textContent).not.toContain("INVALID_PAYLOAD");
  });

  it.skip("15) cobrança disponível: mostra QR real e código copia-e-cola", async () => {
    mockFetchRouter({
      establishment: () => ({ establishment: establishment(), exists: true }),
      subscribe: () => ({
        status: 200,
        body: { status: "payment_required", payment: { pixCopyPaste: "00020126copiaecola", qrCode: "BASE64PNGDATA" } },
      }),
    });
    render(<PlanoPage />);
    fireEvent.click(await screen.findByRole("button", { name: /contratar lívia/i }));
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
    expect(screen.queryByRole("button", { name: /contratar lívia/i })).toBeNull();
    expect(screen.queryByPlaceholderText("000.000.000-00")).toBeNull();
  });

  it("17) carregar/renderizar a página nunca dispara POST /api/billing/subscribe sozinho, nem clicando no botão desabilitado", async () => {
    mockFetchRouter({ establishment: () => ({ establishment: establishment(), exists: true }) });
    render(<PlanoPage />);
    const btn = await screen.findByRole("button", { name: /contratação em breve/i });
    expect(subscribeCalls()).toHaveLength(0);
    fireEvent.click(btn);
    expect(subscribeCalls()).toHaveLength(0);
  });
});
