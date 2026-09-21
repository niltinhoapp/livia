// @vitest-environment jsdom
// F2 da Lívia Alimentação V2 — a tela que passou a consumir
// /api/orders/settings. Cobre a conversão entre o que o backend guarda e o
// que o formulário mostra (ida e volta), as travas de formulário, e o
// comportamento de carregar/salvar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OrderSettingsEditor, toDraft, toSettings, validateDraft } from "./OrderSettingsEditor";
import type { OrderSettings } from "@/types";

const settings = (patch: Partial<OrderSettings> = {}): OrderSettings => ({
  pickupEnabled: true,
  deliveryEnabled: false,
  deliveryRules: [{ kind: "fixed", feeCents: 0 }],
  acceptedPaymentMethods: ["pix", "cash", "credit_card", "debit_card"],
  pixInstructions: null,
  ...patch,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("conversão entre OrderSettings e formulário", () => {
  it("ida e volta preserva taxa padrão, bairros e instruções de PIX", () => {
    const original = settings({
      deliveryEnabled: true,
      deliveryRules: [
        { kind: "neighborhood", neighborhood: "Jardim América", feeCents: 600 },
        { kind: "fixed", feeCents: 900 },
      ],
      acceptedPaymentMethods: ["pix", "cash"],
      pixInstructions: "Chave: 11999998888",
    });

    const roundTrip = toSettings(toDraft(original));

    expect(roundTrip.deliveryEnabled).toBe(true);
    expect(roundTrip.acceptedPaymentMethods).toEqual(["pix", "cash"]);
    expect(roundTrip.pixInstructions).toBe("Chave: 11999998888");
    expect(roundTrip.deliveryRules).toContainEqual({ kind: "neighborhood", neighborhood: "Jardim América", feeCents: 600 });
    expect(roundTrip.deliveryRules).toContainEqual({ kind: "fixed", feeCents: 900 });
  });

  it("sem taxa padrão, nenhuma regra fixa é enviada (a Livia recusa bairro não listado)", () => {
    const draft = toDraft(settings({ deliveryEnabled: true, deliveryRules: [{ kind: "neighborhood", neighborhood: "Centro", feeCents: 500 }] }));

    const result = toSettings(draft);

    expect(draft.fallbackEnabled).toBe(false);
    expect(result.deliveryRules.some((r) => r.kind === "fixed")).toBe(false);
  });

  it("instrução de PIX em branco vira null, não string vazia", () => {
    expect(toSettings(toDraft(settings({ pixInstructions: "   " }))).pixInstructions).toBeNull();
  });

  it("preserva templates operacionais explicitamente configurados", () => {
    const original = settings({ notificationTemplates: { accepted: { templateName: "pedido_aceito", languageCode: "pt_BR" } } });
    expect(toSettings(toDraft(original)).notificationTemplates).toEqual({ accepted: { templateName: "pedido_aceito", languageCode: "pt_BR" } });
  });

  it("bairro sem nome é descartado na hora de salvar", () => {
    const draft = { ...toDraft(settings({ deliveryEnabled: true })), neighborhoods: [{ key: "a", name: "  ", feeText: "5,00" }, { key: "b", name: "Centro", feeText: "5,00" }] };

    expect(toSettings(draft).deliveryRules.filter((r) => r.kind === "neighborhood")).toHaveLength(1);
  });
});

describe("travas de formulário", () => {
  it("recusa salvar sem retirada nem entrega", () => {
    const draft = toDraft(settings({ pickupEnabled: false, deliveryEnabled: false }));
    expect(validateDraft(draft)).toMatch(/retirada ou entrega/i);
  });

  it("recusa salvar sem nenhuma forma de pagamento", () => {
    const draft = toDraft(settings({ acceptedPaymentMethods: [] }));
    expect(validateDraft(draft)).toMatch(/forma de pagamento/i);
  });

  it("recusa taxa inválida", () => {
    const draft = { ...toDraft(settings({ deliveryEnabled: true })), fallbackEnabled: true, fallbackFeeText: "abc" };
    expect(validateDraft(draft)).toMatch(/taxa padrão/i);
  });

  it("recusa entrega ligada sem taxa padrão e sem bairro", () => {
    const draft = { ...toDraft(settings({ deliveryEnabled: true })), fallbackEnabled: false, neighborhoods: [] };
    expect(validateDraft(draft)).toMatch(/taxa padrão ou pelo menos um bairro/i);
  });

  it("aceita configuração válida", () => {
    expect(validateDraft(toDraft(settings()))).toBeNull();
  });

  it("recusa nome inválido de template antes de salvar", () => {
    const draft = toDraft(settings());
    draft.notificationTemplates.accepted.templateName = "Pedido Aceito";
    expect(validateDraft(draft)).toMatch(/template inválido/i);
  });
});

describe("OrderSettingsEditor (tela)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      ({ ok: true, json: async () => ({ settings: init?.method === "PUT" ? JSON.parse(String(init.body)) as OrderSettings : settings() }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
  });

  it("carrega as configurações atuais do backend", async () => {
    render(<OrderSettingsEditor />);

    expect(await screen.findByText("Configurações de pedido")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/orders/settings");
  });

  it("campos de entrega só aparecem com entrega ligada", async () => {
    render(<OrderSettingsEditor />);
    await screen.findByText("Configurações de pedido");

    expect(screen.queryByText("Taxa de entrega")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /Entrega/ }));

    expect(await screen.findByText("Taxa de entrega")).toBeTruthy();
  });

  it("salva no backend o que foi editado na tela", async () => {
    render(<OrderSettingsEditor />);
    await screen.findByText("Configurações de pedido");

    fireEvent.click(screen.getByRole("button", { name: "PIX" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PUT");
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body)) as OrderSettings;
      expect(body.acceptedPaymentMethods).not.toContain("pix");
    });
  });

  it("não chama o backend quando a configuração trava a operação", async () => {
    render(<OrderSettingsEditor />);
    await screen.findByText("Configurações de pedido");

    fireEvent.click(screen.getByRole("checkbox", { name: /Retirada no balcão/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }));

    expect(await screen.findByText(/retirada ou entrega/i)).toBeTruthy();
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("instruções de PIX só aparecem quando PIX está aceito", async () => {
    render(<OrderSettingsEditor />);
    await screen.findByText("Configurações de pedido");

    expect(screen.getByText("Instruções de PIX")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "PIX" }));

    await waitFor(() => expect(screen.queryByText("Instruções de PIX")).toBeNull());
  });
});
