import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveEstablishmentId = vi.fn();
const getMessage = vi.fn();
const readConversationAttachment = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: (...args: unknown[]) => resolveEstablishmentId(...args),
}));
vi.mock("@/lib/repo", () => ({
  getMessage: (...args: unknown[]) => getMessage(...args),
}));
vi.mock("@/lib/attachments/storage", () => ({
  readConversationAttachment: (...args: unknown[]) => readConversationAttachment(...args),
}));

const { GET } = await import("./route");

const attachment = {
  id: "a1",
  type: "document",
  mimeType: "application/pdf",
  filename: "laudo clínico.pdf",
  sizeBytes: 6,
  metaMediaId: "media-1",
  storageRef: "establishments/est_a/conversations/conv_1/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf",
  createdAt: 1,
};

function request(conversationId = "conv_1", messageId = "msg_1") {
  return GET(new Request("https://livia.test/anexo") as never, {
    params: Promise.resolve({ id: conversationId, messageId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveEstablishmentId.mockResolvedValue("est_a");
  getMessage.mockResolvedValue({ id: "msg_1", attachment });
  readConversationAttachment.mockResolvedValue(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]));
});

describe("GET anexo privado da conversa", () => {
  it("entrega PDF somente após resolver o tenant da sessão", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(getMessage).toHaveBeenCalledWith("est_a", "conv_1", "msg_1");
    expect(readConversationAttachment).toHaveBeenCalledWith("est_a", "conv_1", attachment.storageRef);
  });

  it("rejeita path traversal antes de consultar o Firestore", async () => {
    const response = await request("../est_b", "msg_1");
    expect(response.status).toBe(404);
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("falha fechado sem sessão", async () => {
    resolveEstablishmentId.mockResolvedValueOnce(null);
    const response = await request();
    expect(response.status).toBe(401);
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("não encontra mensagem de outro tenant", async () => {
    resolveEstablishmentId.mockResolvedValueOnce("est_b");
    getMessage.mockResolvedValueOnce(null);
    const response = await request();
    expect(response.status).toBe(404);
    expect(getMessage).toHaveBeenCalledWith("est_b", "conv_1", "msg_1");
    expect(readConversationAttachment).not.toHaveBeenCalled();
  });

  it("não expõe erro interno quando o storage está indisponível", async () => {
    readConversationAttachment.mockRejectedValueOnce(new Error("bucket secret detail"));
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "anexo indisponível" });
  });
});
