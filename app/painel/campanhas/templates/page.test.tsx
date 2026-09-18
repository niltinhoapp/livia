// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CampaignTemplatesPage from "./page";
import { TemplatesTable } from "./_components/TemplatesTable";
import { DEMO_TEMPLATES } from "./_fixtures";

afterEach(() => {
  cleanup();
});

describe("CampaignTemplatesPage — estado padrão (sem integração Meta)", () => {
  it("mostra empty state real, sem chamar API da Meta", () => {
    render(<CampaignTemplatesPage />);
    expect(screen.getByText("Nenhum template disponível ainda")).toBeTruthy();
  });
});

describe("TemplatesTable — estrutura com dados (fixtures de demonstração)", () => {
  it("mostra nome, categoria, idioma, status e preview de cada template", () => {
    render(<TemplatesTable templates={DEMO_TEMPLATES} />);
    expect(screen.getByText("reativacao_30_dias")).toBeTruthy();
    expect(screen.getAllByText(/marketing.*pt_br/i).length).toBe(2); // 2 templates de fixture são categoria Marketing
    expect(screen.getByText("Aprovado")).toBeTruthy();
    expect(screen.getByText("Em análise")).toBeTruthy();
    expect(screen.getByText("Rejeitado")).toBeTruthy();
    expect(screen.getByText(/sentimos sua falta/i)).toBeTruthy();
  });
});
