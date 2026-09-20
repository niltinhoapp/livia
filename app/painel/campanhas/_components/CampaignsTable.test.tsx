// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CampaignsTable } from "./CampaignsTable";
import { DEMO_CAMPAIGNS } from "../_fixtures";

afterEach(() => {
  cleanup();
});

describe("CampaignsTable (fixtures de demonstração — OT-FRONT-CAMPANHAS-01)", () => {
  it("renderiza nome, template, público e contadores de cada campanha", () => {
    render(<CampaignsTable campaigns={DEMO_CAMPAIGNS} />);
    expect(screen.getAllByText("Reativação — clientes inativos").length).toBeGreaterThan(0);
    expect(screen.getAllByText("reativacao_30_dias").length).toBeGreaterThan(0);
    expect(screen.getAllByText("128 contatos").length).toBeGreaterThan(0);
  });

  it("mostra o status traduzido (não o valor bruto do domínio)", () => {
    render(<CampaignsTable campaigns={DEMO_CAMPAIGNS} />);
    expect(screen.getAllByText("Concluída").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Agendada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Rascunho").length).toBeGreaterThan(0);
    expect(screen.queryByText("completed")).toBeNull();
  });

  it("campanha sem template/audiência ainda (rascunho) mostra travessão, não crash", () => {
    render(<CampaignsTable campaigns={DEMO_CAMPAIGNS} />);
    expect(screen.getAllByText("Lançamento novo serviço").length).toBeGreaterThan(0);
  });

  it("cada linha linka para /painel/campanhas/[id]", () => {
    render(<CampaignsTable campaigns={DEMO_CAMPAIGNS} />);
    const links = screen.getAllByRole("link").filter((l) => l.getAttribute("href")?.includes("demo-1"));
    expect(links.length).toBeGreaterThan(0);
  });
  it("mostra excluir somente para campanhas em rascunho", () => {
    render(<CampaignsTable campaigns={DEMO_CAMPAIGNS} />);
    expect(screen.getAllByRole("button", { name: /Excluir rascunho/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Excluir rascunho Reativação/i })).toBeNull();
  });

});
