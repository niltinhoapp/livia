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

const { PATCH } = await import("@/app/api/conversations/[id]/route");

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
  return PATCH(req as never, { params: { id: CONV } });
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
