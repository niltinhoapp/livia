import { createHash } from "crypto";
import OpenAI from "openai";
import { db, sub } from "@/lib/firebase/admin";
import { listMenuCategories, saveMenuCategory, saveMenuProduct } from "@/lib/orders";
import { logError } from "@/lib/observability";
import type { MenuImageImport, MenuImportDraftProduct, MenuImportPreview, MenuModifierGroup, MenuVariant } from "@/types";

const MAX_BYTES = 12 * 1024 * 1024;
const MIN_SIDE = 320;
const MAX_SIDE = 8000;
const MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const VISION_MODEL = "gpt-4o-mini";
export type MenuImageValidationCode = "unsupported_type" | "too_large" | "corrupt_image" | "too_small" | "too_large_dimensions";
export class MenuImportError extends Error { constructor(public readonly code: string) { super(code); } }

export interface ValidatedMenuImage { bytes: Uint8Array; mimeType: string; width: number; height: number; hash: string; }

const typeAt = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
const be32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
const le32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); return crc >>> 0; });

function crc32(bytes: Uint8Array, start: number, end: number) { let crc = 0xffffffff; for (let i = start; i < end; i += 1) crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function pngSize(bytes: Uint8Array) {
  if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return null;
  let offset = 8, width = 0, height = 0, sawHeader = false, sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = be32(bytes, offset), dataStart = offset + 8, dataEnd = dataStart + length, end = dataEnd + 4;
    if (end > bytes.length || dataEnd < dataStart) return null;
    const type = typeAt(bytes, offset + 4);
    if (crc32(bytes, offset + 4, dataEnd) !== be32(bytes, dataEnd)) return null;
    if (!sawHeader) { if (type !== "IHDR" || length !== 13) return null; width = be32(bytes, dataStart); height = be32(bytes, dataStart + 4); if (!width || !height) return null; sawHeader = true; }
    else if (type === "IDAT") sawData = true;
    else if (type === "IEND") return length === 0 && sawData && end === bytes.length ? { width, height } : null;
    offset = end;
  }
  return null;
}
function jpegSize(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]; if (marker === undefined || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset]! << 8) + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) return null;
    const data = offset + 2;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const components = bytes[data + 5];
      if (length < 8 || bytes[data] === 0 || !components || length < 8 + 3 * components) return null;
      const height = (bytes[data + 1]! << 8) + bytes[data + 2]!, width = (bytes[data + 3]! << 8) + bytes[data + 4]!;
      return width && height ? { width, height } : null;
    }
    // Depois de SOS os bytes são entropy-coded, não uma sequência de markers.
    if (marker === 0xda) return null;
    offset += length;
  }
  return null;
}
function webpSize(bytes: Uint8Array) {
  if (bytes.length < 20 || typeAt(bytes, 0) !== "RIFF" || typeAt(bytes, 8) !== "WEBP" || le32(bytes, 4) !== bytes.length - 8) return null;
  let offset = 12, size: { width: number; height: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const type = typeAt(bytes, offset), length = le32(bytes, offset + 4), data = offset + 8, end = data + length;
    if (end > bytes.length || end < data) return null;
    if (!size && type === "VP8X" && length >= 10) size = { width: 1 + bytes[data + 4]! + (bytes[data + 5]! << 8) + (bytes[data + 6]! << 16), height: 1 + bytes[data + 7]! + (bytes[data + 8]! << 8) + (bytes[data + 9]! << 16) };
    if (!size && type === "VP8 " && length >= 10 && bytes[data] !== undefined && (bytes[data]! & 1) === 0 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) size = { width: ((bytes[data + 6]! | (bytes[data + 7]! << 8)) & 0x3fff), height: ((bytes[data + 8]! | (bytes[data + 9]! << 8)) & 0x3fff) };
    if (!size && type === "VP8L" && length >= 5 && bytes[data] === 0x2f) size = { width: 1 + bytes[data + 1]! + ((bytes[data + 2]! & 0x3f) << 8), height: 1 + (bytes[data + 2]! >> 6) + (bytes[data + 3]! << 2) + ((bytes[data + 4]! & 0x0f) << 10) };
    offset = end + (length % 2);
  }
  return offset === bytes.length && size && size.width > 0 && size.height > 0 ? size : null;
}
function dimensions(bytes: Uint8Array, mime: string) { return mime === "image/png" ? pngSize(bytes) : mime === "image/jpeg" ? jpegSize(bytes) : webpSize(bytes); }
export function validateMenuImage(bytes: Uint8Array, mimeType: string): ValidatedMenuImage {
  if (!MIME.has(mimeType)) throw new MenuImportError("unsupported_type");
  if (!bytes.length || bytes.length > MAX_BYTES) throw new MenuImportError("too_large");
  const size = dimensions(bytes, mimeType); if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) throw new MenuImportError("corrupt_image");
  if (Math.min(size.width, size.height) < MIN_SIDE) throw new MenuImportError("too_small");
  if (Math.max(size.width, size.height) > MAX_SIDE) throw new MenuImportError("too_large_dimensions");
  return { bytes, mimeType, width: size.width, height: size.height, hash: createHash("sha256").update(bytes).digest("hex") };
}
const clean = (value: unknown, max = 160) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const cents = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
function variants(value: unknown): MenuVariant[] { return Array.isArray(value) ? value.flatMap((v, i) => { const name = clean(v?.name, 100), delta = cents(v?.priceDeltaCents); return name && delta !== null ? [{ id: clean(v?.id, 80) || `variant-${i + 1}`, name, priceDeltaCents: delta, active: v?.active !== false }] : []; }) : []; }
function modifiers(value: unknown): MenuModifierGroup[] { return Array.isArray(value) ? value.flatMap((rawGroup, i) => { const g = rawGroup as Record<string, unknown>; const name = clean(g.name, 100); const rawOptions = Array.isArray(g.options) ? g.options as unknown[] : []; const options = rawOptions.flatMap((rawOption, j) => { const o = rawOption as Record<string, unknown>; const option = clean(o.name, 100), delta = cents(o.priceDeltaCents); return option && delta !== null ? [{ id: clean(o.id, 80) || `option-${i + 1}-${j + 1}`, name: option, priceDeltaCents: delta, active: o.active !== false }] : []; }); if (!name || !options.length) return []; const required = Boolean(g.required), max = Number.isInteger(g.maxSelections) ? Math.max(0, Number(g.maxSelections)) : options.length, min = Number.isInteger(g.minSelections) ? Math.max(required ? 1 : 0, Number(g.minSelections)) : required ? 1 : 0; return min <= max ? [{ id: clean(g.id, 80) || `group-${i + 1}`, name, required, minSelections: min, maxSelections: max, options }] : []; }) : []; }
export function normalizeMenuImportPreview(value: unknown): MenuImportPreview {
  const raw = value && typeof value === "object" ? value as { categories?: unknown; products?: unknown } : {};
  const products = Array.isArray(raw.products) ? raw.products.flatMap((rawProduct, i): MenuImportDraftProduct[] => { const p = rawProduct as Record<string, unknown>; const name = clean(p.name, 120), categoryName = clean(p.categoryName, 100); if (!name || !categoryName) return []; const price = cents(p.basePriceCents); const reasons = Array.isArray(p.reviewReasons) ? (p.reviewReasons as unknown[]).map((x: unknown) => clean(x, 120)).filter(Boolean).slice(0, 5) : []; if (price === null && !reasons.includes("Preço ausente ou ilegível")) reasons.push("Preço ausente ou ilegível"); return [{ id: clean(p.id, 80) || `item-${i + 1}`, categoryName, name, description: clean(p.description, 500) || null, basePriceCents: price, variants: variants(p.variants), modifierGroups: modifiers(p.modifierGroups), reviewReasons: reasons }]; }) : [];
  const categories = [...new Set([...(Array.isArray(raw.categories) ? raw.categories.map((x) => clean(x, 100)).filter(Boolean) : []), ...products.map((p) => p.categoryName)])];
  return { categories, products };
}
export interface MenuVision { recognize(image: ValidatedMenuImage): Promise<unknown>; }
export const liveMenuVision: MenuVision = { async recognize(image) { const apiKey = process.env.OPENAI_API_KEY?.trim(); if (!apiKey) throw new MenuImportError("missing_api_key"); const model = process.env.LIVIA_MENU_IMPORT_MODEL?.trim() || VISION_MODEL; const data = Buffer.from(image.bytes).toString("base64"); try { const client = new OpenAI({ apiKey }); const result = await client.chat.completions.create({ model, response_format: { type: "json_object" }, messages: [{ role: "system", content: "Extraia SOMENTE o cardápio de restaurante em JSON. Ignore screenshots de WhatsApp, barras do celular, margens, banners, contatos e qualquer texto fora da região do cardápio. Retorne {categories:string[],products:[{categoryName,name,description,basePriceCents,variants:[{name,priceDeltaCents}],modifierGroups:[{name,required,minSelections,maxSelections,options:[{name,priceDeltaCents}]}],reviewReasons:string[]}]}. Preços são INTEIROS EM CENTAVOS apenas quando legíveis; dados ausentes ou duvidosos devem ficar nulos/vazios com reviewReasons. Nunca invente valores." }, { role: "user", content: [{ type: "text", text: "Leia esta imagem de cardápio." }, { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${data}` } }] }] }, { timeout: 30_000, maxRetries: 0 }); const content = result.choices[0]?.message.content; if (!content) throw new MenuImportError("invalid_ai_response"); try { return JSON.parse(content); } catch { throw new MenuImportError("invalid_ai_response"); } } catch (error) { if (error instanceof MenuImportError) { if (error.code === "invalid_ai_response") logError({ category: "ai_openai", operation: "menu_import.invalid_ai_response", error }); throw error; } logError({ category: "ai_openai", operation: "menu_import.provider_error", error: new Error(error instanceof Error ? error.name : "unknown") }); throw new MenuImportError("ai_failed"); } } };

const ref = (est: string, id: string) => sub(est, "menuImports").doc(id);
export async function listMenuImports(establishmentId: string): Promise<MenuImageImport[]> { const snap = await sub(establishmentId, "menuImports").orderBy("updatedAt", "desc").limit(100).get(); return snap.docs.map((d) => d.data() as MenuImageImport); }
export async function processMenuImage(establishmentId: string, fileName: string, image: ValidatedMenuImage, vision: MenuVision = liveMenuVision): Promise<{ kind: "duplicate" | "processed"; item: MenuImageImport }> {
  const document = ref(establishmentId, image.hash); const now = Date.now(); let shouldProcess = false;
  const reserved = await db.runTransaction(async (tx) => { const snap = await tx.get(document); if (snap.exists) { const current = snap.data() as MenuImageImport; if (current.status !== "failed") return current; const retry = { ...current, status: "processing" as const, attemptCount: current.attemptCount + 1, errorCode: null, updatedAt: now }; tx.set(document, retry); shouldProcess = true; return retry; } const created: MenuImageImport = { id: image.hash, establishmentId, hash: image.hash, fileName: clean(fileName, 160) || "cardapio", mimeType: image.mimeType, byteSize: image.bytes.length, status: "processing", attemptCount: 1, preview: null, errorCode: null, createdAt: now, updatedAt: now, confirmedAt: null }; tx.create(document, created); shouldProcess = true; return created; });
  if (!shouldProcess) return { kind: "duplicate", item: reserved };
  try { const preview = normalizeMenuImportPreview(await vision.recognize(image)); if (!preview.products.length) throw new MenuImportError("empty_result"); const ready: MenuImageImport = { ...reserved, status: "ready", preview, errorCode: null, updatedAt: Date.now() }; await document.set(ready); return { kind: "processed", item: ready }; } catch (error) { const failed: MenuImageImport = { ...reserved, status: "failed", errorCode: error instanceof MenuImportError ? error.code : "ai_failed", updatedAt: Date.now() }; await document.set(failed); return { kind: "processed", item: failed }; }
}
export async function updateMenuImportPreview(establishmentId: string, id: string, preview: unknown): Promise<MenuImageImport> { const document = ref(establishmentId, id); const snap = await document.get(); if (!snap.exists) throw new MenuImportError("not_found"); const current = snap.data() as MenuImageImport; if (current.status !== "ready") throw new MenuImportError("preview_not_editable"); const next = { ...current, preview: normalizeMenuImportPreview(preview), updatedAt: Date.now() }; await document.set(next); return next; }
const key = (v: string) => v.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");
export async function confirmMenuImport(establishmentId: string, id: string): Promise<MenuImageImport> { const document = ref(establishmentId, id); const now = Date.now(); let job!: MenuImageImport; await db.runTransaction(async (tx) => { const snap = await tx.get(document); if (!snap.exists) throw new MenuImportError("not_found"); const current = snap.data() as MenuImageImport; if (current.status === "confirmed") { job = current; return; } if (current.status !== "ready" && !(current.status === "processing" && now - current.updatedAt > 120_000)) throw new MenuImportError("confirmation_in_progress"); if (!current.preview?.products.length || current.preview.products.some((p) => p.basePriceCents === null || p.reviewReasons.length)) throw new MenuImportError("preview_requires_review"); job = { ...current, status: "processing", updatedAt: now }; tx.set(document, job); }); if (job.status === "confirmed") return job;
  const existing = await listMenuCategories(establishmentId); const categoryIds = new Map(existing.map((c) => [key(c.name), c.id])); const createdCategoryIds: string[] = []; for (const [index, category] of job.preview!.categories.entries()) { const normalized = key(category); if (!categoryIds.has(normalized)) { const saved = await saveMenuCategory(establishmentId, { name: category, active: true, sortOrder: existing.length + index }, `import-${id}-category-${index}`); categoryIds.set(normalized, saved.id); createdCategoryIds.push(saved.id); } }
  const createdProductIds: string[] = []; for (const [index, product] of job.preview!.products.entries()) { const productId = `import-${id}-product-${index}`; const saved = await saveMenuProduct(establishmentId, { categoryId: categoryIds.get(key(product.categoryName))!, name: product.name, description: product.description, basePriceCents: product.basePriceCents!, active: true, variants: product.variants, modifierGroups: product.modifierGroups }, productId); createdProductIds.push(saved.id); }
  const confirmed: MenuImageImport = { ...job, status: "confirmed", confirmedAt: Date.now(), updatedAt: Date.now(), createdCategoryIds, createdProductIds }; await document.set(confirmed); return confirmed;
}
