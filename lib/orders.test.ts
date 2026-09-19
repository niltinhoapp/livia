import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/firebase/admin", () => ({ db: {}, sub: vi.fn() }));
vi.mock("@/lib/whatsapp/client", () => ({ normalizePhone: (v: string) => v }));
import { calculateItem, deliveryFee, normalizeOrderSettings, normalizeProduct } from "@/lib/orders";

const product = () => normalizeProduct({ categoryId: "burgers", name: "X-Burguer", basePriceCents: 2000, variants: [{ id: "double", name: "Duplo", priceDeltaCents: 800, active: true }], modifierGroups: [{ id: "extra", name: "Adicionais", required: false, minSelections: 0, maxSelections: 2, options: [{ id: "bacon", name: "Bacon", priceDeltaCents: 400, active: true }] }] }, "x", 1);

describe("domínio de pedidos", () => {
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
  it("determina taxa por bairro e nunca estima sem regra", () => {
    const settings = normalizeOrderSettings({ deliveryEnabled: true, deliveryRules: [{ kind: "fixed", feeCents: 900 }, { kind: "neighborhood", neighborhood: "Centro", feeCents: 500 }] });
    expect(deliveryFee(settings, "pickup")).toBe(0);
    expect(deliveryFee(settings, "delivery", "centro")).toBe(500);
    expect(deliveryFee(settings, "delivery", "Outro")).toBe(900);
    expect(() => deliveryFee(normalizeOrderSettings({ deliveryEnabled: false }), "delivery", "Centro")).toThrow(/Entrega/);
  });
});
