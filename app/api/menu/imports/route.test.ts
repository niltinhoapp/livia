import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const processMenuImage = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", () => ({ resolveEstablishmentId: vi.fn(async () => "est-a") }));
vi.mock("@/lib/observability", () => ({ logError }));
vi.mock("@/lib/firebase/admin", async () => { const fake = await import("@/lib/__testing__/firestoreFake"); return { db: fake.fakeDb, sub: fake.sub }; });
vi.mock("@/lib/menuImport", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/menuImport")>()), processMenuImage }));
import { POST } from "./route";

const png = () => new Uint8Array(readFileSync(path.join(process.cwd(), "public/livia-icon-oficial-master.png")));
const request = (bytes: Uint8Array, type = "image/png") => { const form = new FormData(); const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; form.set("file", new File([body], "cardapio.png", { type })); return new NextRequest("http://localhost/api/menu/imports", { method: "POST", body: form }); };
const ready = { kind: "processed" as const, item: { id: "hash", status: "ready" } };

beforeEach(() => { processMenuImage.mockReset(); logError.mockReset(); });

describe("POST /api/menu/imports", () => {
  it("retorna 400/corrupt_image e registra image_validation_failed para imagem inválida", async () => {
    const response = await POST(request(new Uint8Array([137, 80, 78, 71]))); const body = await response.json();
    expect(response.status).toBe(400); expect(body).toMatchObject({ code: "corrupt_image", error: "Não foi possível ler esta imagem." });
    expect(processMenuImage).not.toHaveBeenCalled(); expect(logError).toHaveBeenCalledWith(expect.objectContaining({ operation: "menu_import.image_validation_failed" }));
  });

  it("encaminha PNG real validado, MIME e bytes para a etapa de visão/importação", async () => {
    processMenuImage.mockResolvedValue(ready);
    const bytes = png(); const response = await POST(request(bytes));
    const [, , image] = processMenuImage.mock.calls[0]!;
    expect(response.status).toBe(201); expect(processMenuImage).toHaveBeenCalledWith("est-a", "cardapio.png", expect.objectContaining({ mimeType: "image/png", width: 1254, height: 1254 })); expect(Buffer.compare(Buffer.from(image.bytes), Buffer.from(bytes))).toBe(0);
  });

  it("preserva resposta de deduplicação", async () => {
    processMenuImage.mockResolvedValue({ ...ready, kind: "duplicate" });
    const response = await POST(request(png()));
    expect(response.status).toBe(200); expect(processMenuImage).toHaveBeenCalledTimes(1);
  });
});
