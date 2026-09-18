// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CampaignDetailPage from "./page";
import { CampaignDetail } from "./CampaignDetail";
import { DEMO_CAMPAIGNS, DEMO_RECIPIENTS } from "../_fixtures";

afterEach(() => {
  cleanup();
});

describe("CampaignDetailPage — estado padrão (sem backend ainda)", () => {
  it("mostra 'campanha não encontrada' real (nenhum GET /api/campaigns/:id existe)", async () => {
    render(<CampaignDetailPage params={Promise.resolve({ id: "qualquer" })} />);
    expect(await screen.findByText("Campanha não encontrada")).toBeTruthy();
  });
});

describe("CampaignDetail — estrutura com dados (fixtures de demonstração)", () => {
  it("mostra cabeçalho, status e contadores da campanha", () => {
    render(<CampaignDetail campaign={DEMO_CAMPAIGNS[0]!} recipients={[]} />);
    expect(screen.getByRole("heading", { name: "Reativação — clientes inativos" })).toBeTruthy();
    expect(screen.getByText("Concluída")).toBeTruthy();
    expect(screen.getByText("128")).toBeTruthy(); // enviados
  });

  it("lista de destinatários mostra status traduzido por linha", () => {
    render(<CampaignDetail campaign={DEMO_CAMPAIGNS[0]!} recipients={DEMO_RECIPIENTS} />);
    expect(screen.getAllByText("Respondeu").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Falhou").length).toBeGreaterThan(0);
  });

  it("sem destinatários: empty state, não tabela vazia quebrada", () => {
    render(<CampaignDetail campaign={DEMO_CAMPAIGNS[0]!} recipients={[]} />);
    expect(screen.getByText("Nenhum destinatário ainda")).toBeTruthy();
  });
});
