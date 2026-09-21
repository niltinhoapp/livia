import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
vi.mock("@/lib/firebase/admin", async () => { const fake = await import("@/lib/__testing__/firestoreFake"); return { db: fake.fakeDb, sub: fake.sub }; });
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { confirmMenuImport, processMenuImage, updateMenuImportPreview, validateMenuImage, type MenuVision } from "@/lib/menuImport";
import { listMenuCategories, listMenuProducts } from "@/lib/orders";

// Arquivos reais produzidos por libvips (via Sharp, já transitivo do Next).
const png = () => new Uint8Array(readFileSync(path.join(process.cwd(), "public/livia-icon-oficial-master.png")));
const realJpeg = async () => new Uint8Array(await sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 30, g: 80, b: 120 } } }).jpeg().toBuffer());
const realWebp = async (lossless = false, alpha = false) => new Uint8Array(await sharp({ create: { width: 320, height: 320, channels: alpha ? 4 : 3, background: { r: 30, g: 80, b: 120, alpha: 0.5 } } }).webp({ lossless }).toBuffer());
const vision = (payload: unknown): MenuVision => ({ recognize: vi.fn(async () => payload) });
const result = { categories: ["Lanches"], products: [{ categoryName: "Lanches", name: "X-Burger", description: "Pão e carne", basePriceCents: 2200, variants: [{ name: "Grande", priceDeltaCents: 500 }], modifierGroups: [{ name: "Adicionais", required: false, minSelections: 0, maxSelections: 2, options: [{ name: "Bacon", priceDeltaCents: 300 }] }], reviewReasons: [] }] };
beforeEach(() => fakeDb.reset());

describe("validação técnica pré-IA", () => {
  it("aceita PNG real com IEND seguido de CRC (regressão F9)", () => { const image = png(); expect([...image.slice(-8)]).toEqual([73, 69, 78, 68, 174, 66, 96, 130]); expect(validateMenuImage(image, "image/png")).toMatchObject({ width: 1254, height: 1254 }); });
  it("rejeita PNG truncado, sem IEND e com estrutura/CRC inválidos", () => { const image = png(); expect(() => validateMenuImage(image.slice(0, -1), "image/png")).toThrow("corrupt_image"); expect(() => validateMenuImage(image.slice(0, image.length - 12), "image/png")).toThrow("corrupt_image"); const invalid = image.slice(); invalid[29] ^= 1; expect(() => validateMenuImage(invalid, "image/png")).toThrow("corrupt_image"); });
  it("aceita JPEG real e rejeita JPEG truncado", async () => { const image = await realJpeg(); expect(validateMenuImage(image, "image/jpeg")).toMatchObject({ width: 320, height: 320 }); expect(() => validateMenuImage(image.slice(0, -2), "image/jpeg")).toThrow("corrupt_image"); });
  it("aceita WEBP VP8, VP8L e VP8X reais e rejeita RIFF inválido", async () => { const vp8 = await realWebp(), vp8l = await realWebp(true), vp8x = await realWebp(false, true); expect(Buffer.from(vp8).toString("ascii", 12, 16)).toBe("VP8 "); expect(Buffer.from(vp8l).toString("ascii", 12, 16)).toBe("VP8L"); expect(Buffer.from(vp8x).toString("ascii", 12, 16)).toBe("VP8X"); for (const image of [vp8, vp8l, vp8x]) expect(validateMenuImage(image, "image/webp")).toMatchObject({ width: 320, height: 320 }); const invalid = vp8.slice(); invalid[4] ^= 1; expect(() => validateMenuImage(invalid, "image/webp")).toThrow("corrupt_image"); });
  it("preserva limites e MIME", () => { expect(() => validateMenuImage(png(), "image/gif")).toThrow("unsupported_type"); expect(() => validateMenuImage(new Uint8Array([137, 80, 78, 71]), "image/png")).toThrow("corrupt_image"); expect(() => validateMenuImage(new Uint8Array(12 * 1024 * 1024 + 1), "image/png")).toThrow("too_large"); });
});

describe("importação isolada e idempotente", () => {
  it("deduplica hash no mesmo tenant, mas nunca entre tenants", async () => { const image = validateMenuImage(png(), "image/png"), ai = vision(result); expect((await processMenuImage("A", "menu.png", image, ai)).kind).toBe("processed"); expect((await processMenuImage("A", "menu.png", image, ai)).kind).toBe("duplicate"); expect((await processMenuImage("B", "menu.png", image, ai)).kind).toBe("processed"); expect(ai.recognize).toHaveBeenCalledTimes(2); });
  it("falha parcial da IA fica registrada e não publica produto", async () => { const imported = await processMenuImage("A", "ruim.png", validateMenuImage(png(), "image/png"), vision({ categories: [], products: [] })); expect(imported.item).toMatchObject({ status: "failed", errorCode: "empty_result" }); expect(await listMenuProducts("A")).toEqual([]); });
  it("prévia incerta não publica; revisão e confirmação dupla criam um único cardápio", async () => { const imported = await processMenuImage("A", "menu.png", validateMenuImage(png(), "image/png"), vision({ ...result, products: [{ ...result.products[0], basePriceCents: null, reviewReasons: ["Preço ilegível"] }] })); await expect(confirmMenuImport("A", imported.item.id)).rejects.toThrow("preview_requires_review"); const edited = await updateMenuImportPreview("A", imported.item.id, result); const concurrent = await Promise.allSettled([confirmMenuImport("A", edited.id), confirmMenuImport("A", edited.id)]); expect(concurrent.filter((item) => item.status === "fulfilled")).toHaveLength(1); await expect(confirmMenuImport("A", edited.id)).resolves.toMatchObject({ status: "confirmed" }); expect(await listMenuCategories("A")).toHaveLength(1); expect(await listMenuProducts("A")).toHaveLength(1); });
});
