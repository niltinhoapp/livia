import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/firebase/admin", async () => { const fake = await import("@/lib/__testing__/firestoreFake"); return { db: fake.fakeDb, sub: fake.sub }; });
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { confirmMenuImport, processMenuImage, updateMenuImportPreview, validateMenuImage, type MenuVision } from "@/lib/menuImport";
import { listMenuCategories, listMenuProducts } from "@/lib/orders";

const png = (width = 600, height = 800) => { const bytes = new Uint8Array(45); bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height); bytes.set([73, 69, 78, 68], 41); return bytes; };
const vision = (payload: unknown): MenuVision => ({ recognize: vi.fn(async () => payload) });
const result = { categories: ["Lanches"], products: [{ categoryName: "Lanches", name: "X-Burger", description: "Pão e carne", basePriceCents: 2200, variants: [{ name: "Grande", priceDeltaCents: 500 }], modifierGroups: [{ name: "Adicionais", required: false, minSelections: 0, maxSelections: 2, options: [{ name: "Bacon", priceDeltaCents: 300 }] }], reviewReasons: [] }] };
beforeEach(() => fakeDb.reset());

describe("validação técnica pré-IA", () => {
  it("rejeita formato, arquivo corrompido, dimensão pequena e grande antes de chamar visão", () => {
    expect(() => validateMenuImage(png(), "image/gif")).toThrow("unsupported_type");
    expect(() => validateMenuImage(new Uint8Array([137, 80, 78, 71]), "image/png")).toThrow("corrupt_image");
    expect(() => validateMenuImage(png(100, 100), "image/png")).toThrow("too_small");
    expect(() => validateMenuImage(png(9000, 800), "image/png")).toThrow("too_large_dimensions");
  });
});

describe("importação isolada e idempotente", () => {
  it("deduplica hash no mesmo tenant, mas nunca entre tenants", async () => {
    const image = validateMenuImage(png(), "image/png"); const ai = vision(result);
    expect((await processMenuImage("A", "menu.png", image, ai)).kind).toBe("processed");
    expect((await processMenuImage("A", "menu.png", image, ai)).kind).toBe("duplicate");
    expect((await processMenuImage("B", "menu.png", image, ai)).kind).toBe("processed");
    expect(ai.recognize).toHaveBeenCalledTimes(2);
  });

  it("duas reservas simultâneas do mesmo hash fazem uma única chamada de visão", async () => {
    const image = validateMenuImage(png(), "image/png"); const ai = vision(result);
    const [first, second] = await Promise.all([processMenuImage("A", "menu.png", image, ai), processMenuImage("A", "menu.png", image, ai)]);
    expect([first.kind, second.kind].sort()).toEqual(["duplicate", "processed"]);
    expect(ai.recognize).toHaveBeenCalledTimes(1);
  });

  it("falha parcial da IA fica registrada e não publica produto", async () => {
    const imported = await processMenuImage("A", "ruim.png", validateMenuImage(png(), "image/png"), vision({ categories: [], products: [] }));
    expect(imported.item).toMatchObject({ status: "failed", errorCode: "empty_result" });
    expect(await listMenuProducts("A")).toEqual([]);
  });

  it("prévia incerta não publica; revisão e confirmação dupla criam um único cardápio", async () => {
    const imported = await processMenuImage("A", "menu.png", validateMenuImage(png(), "image/png"), vision({ ...result, products: [{ ...result.products[0], basePriceCents: null, reviewReasons: ["Preço ilegível"] }] }));
    await expect(confirmMenuImport("A", imported.item.id)).rejects.toThrow("preview_requires_review");
    const edited = await updateMenuImportPreview("A", imported.item.id, result);
    const concurrent = await Promise.allSettled([confirmMenuImport("A", edited.id), confirmMenuImport("A", edited.id)]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(confirmMenuImport("A", edited.id)).resolves.toMatchObject({ status: "confirmed" });
    expect(await listMenuCategories("A")).toHaveLength(1); expect(await listMenuProducts("A")).toHaveLength(1);
    const product = (await listMenuProducts("A"))[0]!; expect(product).toMatchObject({ name: "X-Burger", basePriceCents: 2200 }); expect(product.variants).toHaveLength(1); expect(product.modifierGroups[0]?.options[0]?.name).toBe("Bacon");
  });

  it("tenant B não edita nem confirma a prévia do tenant A", async () => {
    const imported = await processMenuImage("A", "menu.png", validateMenuImage(png(), "image/png"), vision(result));
    await expect(updateMenuImportPreview("B", imported.item.id, result)).rejects.toThrow("not_found");
    await expect(confirmMenuImport("B", imported.item.id)).rejects.toThrow("not_found");
    expect(await listMenuProducts("B")).toEqual([]);
  });
});
