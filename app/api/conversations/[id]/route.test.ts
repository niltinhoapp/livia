// Saída explícita do handoff: "Assumir conversa" / "Devolver para Livia".
//
// É o único caminho de volta — não existe retomada automática de propósito,
// para a Livia nunca voltar a responder por cima de um atendente.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PendingTask } from "@/types";

const getConversation = vi.fn();
const setConversationStatus = vi.fn();
const resolvePendingTask = vi.fn();
const getPendingTask = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: vi.fn(async () => "est_odonto"),
}));

vi.mock("@/lib/repo", () => ({
  getConversation: (...a: unknown[]) => getConversation(...a),
  listMessages: vi.fn(async () => []),
  setConversationStatus: (...a: unknown[]) => setConversationStatus(...a),
  resolvePendingTask: (...a: unknown[]) => resolvePendingTask(...a),
  getPendingTask: (...a: unknown[]) => getPendingTask(...a),
}));

const { GET, PATCH } = await import("@/app/api/conversations/[id]/route");

const CONV = "5514991234567";

function pending(over: Partial<PendingTask> = {}): PendingTask {
  return {
    id: CONV,
    establishmentId: "est_odonto",
    conversationId: CONV,
    contactPhone: CONV,
    type: "awaiting_human",
    waitingFor: "atendimento humano",
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    resolvedAt: null,
    dueAt: null,
    ...over,
  } as PendingTask;
}

async function patch(action: string) {
  const req = new Request(`https://livia.test/api/conversations/${CONV}`, {
    method: "PATCH",
    body: JSON.stringify({ action }),
  });
  return PATCH(req as never, { params: Promise.resolve({ id: CONV }) });
}

async function get(conversationId = CONV) {
  const req = new Request(`https://livia.test/api/conversations/${conversationId}`);
  return GET(req as never, { params: Promise.resolve({ id: conversationId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getConversation.mockResolvedValue({ id: CONV, status: "handoff" });
  getPendingTask.mockResolvedValue(pending());
});

describe("saída do handoff", () => {
  it("assumir: conversa vira human e a pendência de humano é resolvida", async () => {
    const res = await patch("assume");

    expect(await res.json()).toMatchObject({ status: "human" });
    expect(setConversationStatus).toHaveBeenCalledWith("est_odonto", CONV, "human");
    expect(resolvePendingTask).toHaveBeenCalledWith("est_odonto", CONV);
  });

  it("devolver: conversa volta pro bot E a pendência de humano é encerrada", async () => {
    // Sem isto a conversa voltava para a Livia mas seguia marcada como
    // "Precisa de humano" na caixa de entrada, para sempre.
    const res = await patch("return");

    expect(await res.json()).toMatchObject({ status: "bot" });
    expect(setConversationStatus).toHaveBeenCalledWith("est_odonto", CONV, "bot");
    expect(resolvePendingTask).toHaveBeenCalledWith("est_odonto", CONV);
  });

  it("devolver NÃO apaga uma pendência de outro tipo, que ninguém atendeu", async () => {
    getPendingTask.mockResolvedValue(pending({ type: "appointment_started_incomplete" }));

    await patch("return");

    expect(setConversationStatus).toHaveBeenCalledWith("est_odonto", CONV, "bot");
    expect(resolvePendingTask).not.toHaveBeenCalled();
  });

  it("devolver sem pendência aberta não quebra", async () => {
    getPendingTask.mockResolvedValue(null);

    const res = await patch("return");

    expect(res.status).toBe(200);
    expect(resolvePendingTask).not.toHaveBeenCalled();
  });

  it("pendência já resolvida não é resolvida de novo", async () => {
    getPendingTask.mockResolvedValue(pending({ status: "resolved" }));

    await patch("return");

    expect(resolvePendingTask).not.toHaveBeenCalled();
  });

  it("action inválida é recusada — não existe transição implícita de estado", async () => {
    const res = await patch("retomar_automatico");

    expect(res.status).toBe(400);
    expect(setConversationStatus).not.toHaveBeenCalled();
  });
});

// OT-BETA-01: isolamento multi-tenant — obrigatório antes de liberar um
// segundo estabelecimento real. A rota nunca lê establishmentId de outro
// lugar além de resolveEstablishmentId(req) (ver comentário no topo de
// route.ts); a leitura em si é sempre escopada por
// establishments/{id}/conversations/{conversationId}, então um
// conversationId de outro tenant simplesmente não existe nesse escopo —
// nunca vaza dado, só retorna 404.
describe("isolamento entre estabelecimentos (OT-BETA-01)", () => {
  it("GET sempre consulta o repo com o establishmentId resolvido pela sessão, nunca outro", async () => {
    await get();
    expect(getConversation).toHaveBeenCalledWith("est_odonto", CONV);
  });

  it("conversationId que só existe em OUTRO tenant: repo retorna null (escopo errado) -> 404, sem vazar dado", async () => {
    // Simula exatamente o que o Firestore real faz: o doc não existe dentro
    // da subcoleção do tenant resolvido (porque pertence a outro).
    getConversation.mockResolvedValue(null);

    const res = await get("conv_de_outro_tenant");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("est_"); // nunca ecoa establishmentId de ninguém
  });

  it("PATCH também nunca aplica ação a uma conversa que não existe no tenant resolvido", async () => {
    getConversation.mockResolvedValue(null);

    const res = await patch("assume");

    expect(res.status).toBe(404);
    expect(setConversationStatus).not.toHaveBeenCalled();
  });
});
