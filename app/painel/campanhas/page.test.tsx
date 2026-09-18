// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CampaignsPage from "./page";

afterEach(() => {
  cleanup();
});

// OT-FRONT-CAMPANHAS-01: sem GET /api/campaigns ainda, o estado padrão real
// é vazio — não deve depender de nenhuma fixture/mock para renderizar
// corretamente.
describe("CampaignsPage — estado padrão (sem backend ainda)", () => {
  it("mostra o empty state real, sem fabricar campanha nenhuma", () => {
    render(<CampaignsPage />);
    expect(screen.getByText("Nenhuma campanha criada ainda.")).toBeTruthy();
    expect(screen.getByText(/crie sua primeira campanha/i)).toBeTruthy();
  });

  it("resumo mostra zero em todas as métricas (nenhum dado inventado)", () => {
    render(<CampaignsPage />);
    const zeros = screen.getAllByText("0");
    expect(zeros.length).toBeGreaterThanOrEqual(5); // Campanhas/Enviados/Entregues/Lidos/Respostas
  });

  it("CTA principal e o CTA do empty state levam para /painel/campanhas/nova", () => {
    render(<CampaignsPage />);
    const links = screen.getAllByRole("link", { name: /campanha/i });
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/painel/campanhas/nova");
    }
  });
});
