// Fix #2 da auditoria de consumo do Firestore (03/09/2026): o poll de 15s de
// /painel/conversas (GET /api/conversations -> classifyConversationsForInbox)
// recalculava oportunidades a cada chamada — 4 queries pesadas (30 dias de
// conversas, 30 dias de cancelamentos, 90 dias de agendamentos futuros) × 4
// vezes por minuto, pela vida inteira da aba aberta.
//
// Este teste prova a propriedade que importa: o caminho quente NUNCA aciona
// as consultas/funções de oportunidade. Mocka os módulos inteiros (nem
// precisa de Firestore fake) — se qualquer uma dessas funções for chamada, o
// teste falha.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, PendingTask } from "@/types";

const listPendingTasks = vi.fn();
vi.mock("@/lib/repo", () => ({
  listPendingTasks: (...a: unknown[]) => listPendingTasks(...a),
}));

const opportunitiesFromPendingTasks = vi.fn();
const priceInquiryOpportunities = vi.fn();
const cancelledNoRebookingOpportunities = vi.fn();
vi.mock("@/lib/ai/opportunities", () => ({
  opportunitiesFromPendingTasks: (...a: unknown[]) => opportunitiesFromPendingTasks(...a),
  priceInquiryOpportunities: (...a: unknown[]) => priceInquiryOpportunities(...a),
  cancelledNoRebookingOpportunities: (...a: unknown[]) => cancelledNoRebookingOpportunities(...a),
}));

// Se o caminho quente chamasse getOpportunities, estas seriam invocadas —
// mockadas só pra garantir que o módulo carrega sem tocar Firestore de
// verdade, caso algo regrida e volte a chamá-las.
vi.mock("@/lib/scheduling", () => ({
  listAppointments: vi.fn(async () => []),
  listAppointmentsCreatedSince: vi.fn(async () => []),
  listAppointmentsCancelledSince: vi.fn(async () => []),
}));

const { classifyConversationsForInbox } = await import("./dashboard");

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "5514996447132",
    establishmentId: "demo",
    contactPhone: "5514996447132",
    contactName: "Nilton",
    status: "bot",
    lastMessageAt: 1000,
    createdAt: 1,
    ...over,
  };
}

function pendingTask(over: Partial<PendingTask> = {}): PendingTask {
  return {
    id: "5514996447132",
    establishmentId: "demo",
    conversationId: "5514996447132",
    contactPhone: "5514996447132",
    type: "awaiting_human",
    waitingFor: "atendimento humano",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    resolvedAt: null,
    dueAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("E — classifyConversationsForInbox não recalcula oportunidades no caminho quente", () => {
  it("nunca chama nenhuma função de detecção de oportunidade", async () => {
    listPendingTasks.mockResolvedValue([pendingTask()]);

    await classifyConversationsForInbox("demo", [conversation()]);

    expect(opportunitiesFromPendingTasks).not.toHaveBeenCalled();
    expect(priceInquiryOpportunities).not.toHaveBeenCalled();
    expect(cancelledNoRebookingOpportunities).not.toHaveBeenCalled();
  });

  it("faz só a query de pendências — nunca as de conversas/cancelamentos/agendamentos de oportunidade", async () => {
    listPendingTasks.mockResolvedValue([]);

    await classifyConversationsForInbox("demo", [conversation()]);

    expect(listPendingTasks).toHaveBeenCalledTimes(1);
  });

  it("categorias que dependem só de pendingTasks continuam corretas sem oportunidades", async () => {
    listPendingTasks.mockResolvedValue([pendingTask({ type: "awaiting_human" })]);

    const result = await classifyConversationsForInbox("demo", [conversation()]);

    expect(result[0]!.inboxCategory).toBe("needs_human");
  });

  it("sem pendência e sem cálculo de oportunidade, a conversa cai em 'resolved' (o merge de oportunidade é responsabilidade do frontend)", async () => {
    listPendingTasks.mockResolvedValue([]);

    const result = await classifyConversationsForInbox("demo", [conversation()]);

    expect(result[0]!.inboxCategory).toBe("resolved");
  });
});
