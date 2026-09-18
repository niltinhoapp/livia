// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import NewCampaignPage from "./page";

afterEach(() => {
  cleanup();
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
    expect(screen.getByText(/templates devem estar aprovados/i)).toBeTruthy();

    // Sem template real (nenhum contrato de backend ainda), o avanço para
    // Revisão fica estruturalmente travado — mesmo padrão de "gate por
    // botão desabilitado" já usado em /painel/plano (OT-BILLING-UI-01).
    // Isso significa que "Enviar agora"/"Agendar" nunca são alcançáveis por
    // clique real nesta fase, o que é intencional.
    const templateContinue = screen.getByRole("button", { name: /continuar/i }) as HTMLButtonElement;
    expect(templateContinue.disabled).toBe(true);
  });
});
