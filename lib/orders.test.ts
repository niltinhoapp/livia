import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/firebase/admin", () => ({ db: {}, sub: vi.fn() }));
vi.mock("@/lib/whatsapp/client", () => ({ normalizePhone: (v: string) => v }));
import { calculateItem, deliveryFee, normalizeOrderSettings, normalizeProduct } from "@/lib/orders";

const product = () => normalizeProduct({ categoryId: "burgers", name: "X-Burguer", basePriceCents: 2000, variants: [{ id: "double", name: "Duplo", priceDeltaCents: 800, active: true }], modifierGroups: [{ id: "extra", name: "Adicionais", required: false, minSelections: 0, maxSelections: 2, options: [{ id: "bacon", name: "Bacon", priceDeltaCents: 400, active: true }] }] }, "x", 1);

describe("domínio de pedidos", () => {
  it("rejeita grupo obrigatório com minSelections zero no backend", () => {
    expect(() => normalizeProduct({ categoryId: "burgers", name: "X-Burguer", basePriceCents: 2000, variants: [], modifierGroups: [{ id: "ponto", name: "Ponto", required: true, minSelections: 0, maxSelections: 1, options: [{ id: "ao-ponto", name: "Ao ponto", priceDeltaCents: 0, active: true }] }] }, "x", 1)).toThrow(/obrigatório.*mínimo/i);
  });

  it("aceita minSelections zero para grupo opcional e preserva limite máximo", () => {
    const normalized = normalizeProduct({ categoryId: "burgers", name: "X-Burguer", basePriceCents: 2000, variants: [], modifierGroups: [{ id: "extra", name: "Extra", required: false, minSelections: 0, maxSelections: 2, options: [{ id: "bacon", name: "Bacon", priceDeltaCents: 400, active: true }] }] }, "x", 1);
    expect(normalized.modifierGroups[0]).toMatchObject({ required: false, minSelections: 0, maxSelections: 2 });
  });

  it("mantém obrigatório um grupo legado inválido já persistido", () => {
    const legacy = { ...product(), modifierGroups: [{ id: "ponto", name: "Ponto", required: true, minSelections: 0, maxSelections: 1, options: [{ id: "ao-ponto", name: "Ao ponto", priceDeltaCents: 0, active: true }] }] };
    expect(() => calculateItem(legacy, null, [], 1)).toThrow(/Seleção inválida/);
  });

  it("rejeita minSelections maior que maxSelections no backend", () => {
    expect(() => normalizeProduct({ categoryId: "burgers", name: "X-Burguer", basePriceCents: 2000, variants: [], modifierGroups: [{ id: "extra", name: "Extra", required: false, minSelections: 2, maxSelections: 1, options: [{ id: "bacon", name: "Bacon", priceDeltaCents: 400, active: true }] }] }, "x", 1)).toThrow(/mínimo.*máximo/i);
  });

  it("calcula item apenas a partir de produto/variante/adicional reais", () => {
    const item = calculateItem(product(), "double", ["bacon"], 2, "sem cebola");
    expect(item.unitPriceCents).toBe(3200);
    expect(item.lineTotalCents).toBe(6400);
    expect(item.notes).toBe("sem cebola");
  });
  it("recusa adicional inexistente e quantidade inválida", () => {
    expect(() => calculateItem(product(), null, ["queijo-inventado"], 1)).toThrow(/indisponível/);
    expect(() => calculateItem(product(), null, [], 0)).toThrow(/Quantidade/);
  });
  it("recusa variante ou adicional que se tornou indisponível", () => {
    const unavailable = product();
    unavailable.variants[0]!.active = false;
    expect(() => calculateItem(unavailable, "double", [], 1)).toThrow(/Variação indisponível/);
    const withoutBacon = product();
    withoutBacon.modifierGroups[0]!.options[0]!.active = false;
    expect(() => calculateItem(withoutBacon, null, ["bacon"], 1)).toThrow(/Adicional indisponível/);
  });
  it("casa o bairro independente de acento, caixa e espaçamento", () => {
    // Regressão: "Jardim América" cadastrado não casava com "jardim america"
    // digitado no WhatsApp, e a taxa caía sem aviso na regra fixa — cobrando
    // o valor errado em silêncio.
    const settings = normalizeOrderSettings({ deliveryEnabled: true, deliveryRules: [{ kind: "fixed", feeCents: 1500 }, { kind: "neighborhood", neighborhood: "Jardim América", feeCents: 600 }] });
    expect(deliveryFee(settings, "delivery", "jardim america")).toBe(600);
    expect(deliveryFee(settings, "delivery", "JARDIM AMÉRICA")).toBe(600);
    expect(deliveryFee(settings, "delivery", "  Jardim   América ")).toBe(600);
    expect(deliveryFee(settings, "delivery", "Jardim Europa")).toBe(1500);
  });

  it("casa o bairro quando o acento está no cadastro ou na fala do cliente", () => {
    const semAcento = normalizeOrderSettings({ deliveryEnabled: true, deliveryRules: [{ kind: "fixed", feeCents: 1500 }, { kind: "neighborhood", neighborhood: "jardim america", feeCents: 600 }] });
    expect(deliveryFee(semAcento, "delivery", "Jardim América")).toBe(600);
  });

  it("determina taxa por bairro e nunca estima sem regra", () => {
    const settings = normalizeOrderSettings({ deliveryEnabled: true, deliveryRules: [{ kind: "fixed", feeCents: 900 }, { kind: "neighborhood", neighborhood: "Centro", feeCents: 500 }] });
    expect(deliveryFee(settings, "pickup")).toBe(0);
    expect(deliveryFee(settings, "delivery", "centro")).toBe(500);
    expect(deliveryFee(settings, "delivery", "Outro")).toBe(900);
    expect(() => deliveryFee(normalizeOrderSettings({ deliveryEnabled: false }), "delivery", "Centro")).toThrow(/Entrega/);
  });
});
