// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewCampaignPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  const fetchMock = vi.fn((url: string) => Promise.resolve({
    ok: true,
    json: async () => url.includes("templates")
      ? { templates: [{ id: "tpl-1", name: "promocao", language: "pt_BR", status: "APPROVED", components: [], senderCompatible: true, campaignCompatible: true }] }
      : { audience: { selected: 3, eligible: 2, excluded: 1 } },
  }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("Nova campanha — wizard (OT-FRONT-CAMPANHAS-01)", () => {
  it("passo 1 (Campanha): Continuar fica desabilitado sem nome", () => {
    render(<NewCampaignPage />);
    const btn = screen.getByRole("button", { name: /continuar/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("avança Campanha -> Público ao preencher o nome e clicar continuar", () => {
    render(<NewCampaignPage />);
    fireEvent.change(screen.getByPlaceholderText(/reativação de clientes/i), {
      target: { value: "Campanha de teste" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    expect(screen.getByRole("heading", { name: "Público" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /todos elegíveis/i })).toBeTruthy();
  });

  it("audiência diferente de 'Todos elegíveis' trava o avanço (importação/segmentação ainda não existem)", () => {
    render(<NewCampaignPage />);
    fireEvent.change(screen.getByPlaceholderText(/reativação de clientes/i), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));

    fireEvent.click(screen.getByRole("tab", { name: /importados/i }));
    const continueBtn = screen.getByRole("button", { name: /continuar/i }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);
  });

  it("passo Template: consulta templates reais e mantém avanço bloqueado sem seleção", () => {
    render(<NewCampaignPage />);
    fireEvent.change(screen.getByPlaceholderText(/reativação de clientes/i), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));

    expect(screen.getByRole("heading", { name: "Template" })).toBeTruthy();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(screen.getByText(/conteúdo vem do template aprovado/i)).toBeTruthy();

    const templateContinue = screen.getByRole("button", { name: /continuar/i }) as HTMLButtonElement;
    expect(templateContinue.disabled).toBe(true);
  });

  it("mostra destinatários reais e exige confirmação explícita antes de enviar", async () => {
    render(<NewCampaignPage />);
    fireEvent.change(screen.getByPlaceholderText(/reativação de clientes/i), { target: { value: "Promoção" } });
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByRole("option", { name: /promocao/i })).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tpl-1" } });
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText(/promocao · pt_BR/i)).toBeTruthy();
    const send = screen.getByRole("button", { name: "Enviar agora" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirmar envio" })).toBeTruthy();
  });

  it("carrega os valores aprovados e personaliza o nome sem preenchimento por contato", async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: async () => url.includes("templates")
        ? { templates: [{ id: "tpl-vars", name: "cupom", language: "pt_BR", status: "APPROVED", components: [{ type: "BODY", text: "Olá {{1}}, use {{2}}", example: { body_text: [["Maria", "LIVIA20"]] } }], senderCompatible: true, campaignCompatible: true }] }
        : { audience: { selected: 3, eligible: 2, excluded: 1 } },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NewCampaignPage />);
    fireEvent.change(screen.getByPlaceholderText(/reativação de clientes/i), { target: { value: "Cupom" } });
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByRole("option", { name: /cupom/i })).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tpl-vars" } });
    expect(screen.getByDisplayValue(/preenchido automaticamente/i)).toBeTruthy();
    const continueButton = screen.getByRole("button", { name: /continuar/i }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);
    expect(screen.getByDisplayValue("LIVIA20")).toBeTruthy();
    expect(screen.getByText(/Olá Nome do cliente, use LIVIA20/i)).toBeTruthy();
  });

  it("remove o rascunho criado quando a preparação da audiência falha", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/campaigns/templates") return Promise.resolve({ ok: true, json: async () => ({ templates: [{ id: "tpl-1", name: "promocao", language: "pt_BR", status: "APPROVED", components: [], senderCompatible: true, campaignCompatible: true }] }) });
      if (url === "/api/campaigns/audience") return Promise.resolve({ ok: true, json: async () => ({ audience: { selected: 3, eligible: 2, excluded: 1 } }) });
      if (url === "/api/campaigns" && init?.method === "POST") return Promise.resolve({ ok: true, json: async () => ({ campaign: { id: "failed-draft" } }) });
      if (url.endsWith("/audience")) return Promise.resolve({ ok: false, json: async () => ({ error: "falha controlada" }) });
      if (url === "/api/campaigns/failed-draft" && init?.method === "DELETE") return Promise.resolve({ ok: true, json: async () => ({ deleted: true }) });
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NewCampaignPage />);
    fireEvent.change(screen.getByPlaceholderText(/reativação de clientes/i), { target: { value: "Falha" } });
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByRole("option", { name: /promocao/i })).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tpl-1" } });
    fireEvent.click(screen.getByRole("button", { name: /continuar/i }));
    fireEvent.click(screen.getByRole("button", { name: "Enviar agora" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar envio" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/campaigns/failed-draft", { method: "DELETE" }));
    expect(screen.getByRole("alert").textContent).toContain("falha controlada");
  });
});
