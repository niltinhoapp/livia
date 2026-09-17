import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  save: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  file: vi.fn(),
  bucket: vi.fn(),
}));

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({ bucket: mocks.bucket }),
}));

const {
  storeConversationAttachment,
  readConversationAttachment,
  sanitizeAttachmentFilename,
} = await import("./storage");

beforeEach(() => {
  vi.stubEnv("FIREBASE_STORAGE_BUCKET", "private-bucket");
  mocks.exists.mockResolvedValue([false]);
  mocks.save.mockResolvedValue(undefined);
  mocks.download.mockResolvedValue([Buffer.from([1, 2, 3])]);
  mocks.remove.mockResolvedValue(undefined);
  mocks.file.mockReturnValue({
    exists: mocks.exists,
    save: mocks.save,
    download: mocks.download,
    delete: mocks.remove,
  });
  mocks.bucket.mockReturnValue({ file: mocks.file });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("storage privado de anexos", () => {
  it("salva em chave opaca e tenant-scoped, sem token ou URL pública", async () => {
    const result = await storeConversationAttachment({
      establishmentId: "est_a",
      conversationId: "5514991234567",
      waMessageId: "wamid.image.1",
      metaMediaId: "media.image.1",
      type: "image",
      mimeType: "image/jpeg",
      filename: "foto.jpg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      createdAt: 10,
    });

    expect(result).toMatchObject({ type: "image", filename: "foto.jpg", sizeBytes: 3, createdAt: 10 });
    expect(result.storageRef).toMatch(/^establishments\/est_a\/conversations\/5514991234567\/attachments\/[a-f0-9]{32}\.jpg$/);
    expect(mocks.bucket).toHaveBeenCalledWith("private-bucket");
    expect(mocks.save).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: expect.objectContaining({ contentType: "image/jpeg", cacheControl: "private, no-store, max-age=0" }),
    }));
    expect(JSON.stringify(mocks.save.mock.calls)).not.toMatch(/token|https?:/i);
  });

  it("é idempotente quando o objeto determinístico já existe", async () => {
    mocks.exists.mockResolvedValueOnce([true]);
    await storeConversationAttachment({
      establishmentId: "est_a", conversationId: "conv_1", waMessageId: "wamid.1", metaMediaId: "media.1",
      type: "document", mimeType: "application/pdf", filename: "a.pdf", bytes: new Uint8Array([1]),
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("sanitiza filename não confiável", () => {
    expect(sanitizeAttachmentFilename("../../segredo.pdf", "application/pdf")).toBe("segredo.pdf");
    expect(sanitizeAttachmentFilename("\u0000", "image/png")).toBe("anexo.png");
    expect(sanitizeAttachmentFilename("\ud800.pdf", "application/pdf")).toBe("_.pdf");
  });

  it("falha fechado sem bucket configurado", async () => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", " ");
    await expect(storeConversationAttachment({
      establishmentId: "est_a", conversationId: "conv_1", waMessageId: "wamid.1", metaMediaId: "media.1",
      type: "image", mimeType: "image/png", bytes: new Uint8Array([1]),
    })).rejects.toMatchObject({ code: "storage_not_configured" });
  });

  it("bloqueia leitura cross-tenant e path traversal antes do bucket", async () => {
    await expect(readConversationAttachment(
      "est_b",
      "conv_1",
      "establishments/est_a/conversations/conv_1/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf",
    )).rejects.toMatchObject({ code: "invalid_storage_scope" });
    await expect(readConversationAttachment(
      "est_a",
      "conv_1",
      "establishments/est_a/conversations/conv_1/attachments/../../secret.pdf",
    )).rejects.toMatchObject({ code: "invalid_storage_scope" });
    expect(mocks.file).not.toHaveBeenCalled();
  });
});
