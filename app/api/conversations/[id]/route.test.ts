// Saída explícita do handoff: "Assumir atendimento" / "Devolver para Lívia".
//
// É o único caminho de volta — não existe retomada automática de propósito,
// para a Livia nunca voltar a responder por cima de um atendente. Integração
// real: rota + lib/humanHandoff/ownership.ts sobre o Firestore fake.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Conversation, PendingTask } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

let actor: { establishmentId: string; uid: string } | null = { establishmentId: "est_odonto", uid: "owner-odonto" };
vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: vi.fn(async () => actor?.establishmentId ?? null),
  resolvePanelActor: vi.fn(async () => actor),
}));

const { fakeDb } = await import("@/lib/__testing__/firestoreFake");
const { GET, PATCH } = await import("@/app/api/conversations/[id]/route");

const CONV = "5514991234567";

function seedConversation(status: Conversation["status"], over: Partial<Conversation> = {}, establishmentId = "est_odonto") {
  fakeDb.col(`establishments/${establishmentId}/conversations`).set(CONV, {
    id: CONV, establishmentId, contactPhone: CONV, contactName: "Ana", status, lastMessageAt: 0, createdAt: 0,
    aiProcessingLease: { leaseId: "lease-ia", acquiredAt: 1, expiresAt: Number.MAX_SAFE_INTEGER },
    ...over,
  });
}

function seedPending(over: Partial<PendingTask> = {}, establishmentId = "est_odonto") {
  fakeDb.col(`establishments/${establishmentId}/pendingTasks`).set(CONV, {
    id: CONV, establishmentId, conversationId: CONV, contactPhone: CONV, type: "awaiting_human",
    waitingFor: "atendimento humano", status: "open", createdAt: 0, updatedAt: 0, resolvedAt: null, dueAt: null, ...over,
  });
}

const conversation = (establishmentId = "est_odonto") => fakeDb.col(`establishments/${establishmentId}/conversations`).get(CONV) as unknown as Conversation;
const pendingTask = () => fakeDb.col("establishments/est_odonto/pendingTasks").get(CONV) as unknown as PendingTask;

async function patch(action: string) {
  const req = new Request(`https://livia.test/api/conversations/${CONV}`, { method: "PATCH", body: JSON.stringify({ action }) });
  return PATCH(req as never, { params: Promise.resolve({ id: CONV }) });
}

async function get(conversationId = CONV) {
  const req = new Request(`https://livia.test/api/conversations/${conversationId}`);
  return GET(req as never, { params: Promise.resolve({ id: conversationId }) });
}

beforeEach(() => {
  fakeDb.reset();
  actor = { establishmentId: "est_odonto", uid: "owner-odonto" };
  seedConversation("handoff", { handoffStartedAt: 500 });
  seedPending();
});

describe("saída do handoff", () => {
  it("H: assumir — conversa vira human, lease da IA é revogado, autor registrado e a pendência resolvida", async () => {
    const res = await patch("assume");

    expect(await res.json()).toMatchObject({ ok: true, status: "human", changed: true });
    expect(conversation()).toMatchObject({ status: "human", aiProcessingLease: null, humanOwnership: { assumedBy: "owner-odonto" } });
    expect(pendingTask().status).toBe("resolved");
  });

  it("M: devolver — human → bot, autor registrado e a pendência de humano encerrada", async () => {
    await patch("assume");
    seedPending();
    const res = await patch("return");

    expect(await res.json()).toMatchObject({ status: "bot", changed: true });
    expect(conversation()).toMatchObject({ status: "bot", handoffStartedAt: null, humanOwnership: { assumedBy: "owner-odonto", returnedBy: "owner-odonto" } });
    expect(pendingTask().status).toBe("resolved");
  });

  it("devolver NÃO apaga uma pendência de outro tipo, que ninguém atendeu", async () => {
    seedConversation("human");
    seedPending({ type: "appointment_started_incomplete" });

    await patch("return");

    expect(conversation().status).toBe("bot");
    expect(pendingTask().status).toBe("open");
  });

  it("devolver sem pendência aberta não quebra", async () => {
    seedConversation("human");
    fakeDb.col("establishments/est_odonto/pendingTasks").clear();

    const res = await patch("return");

    expect(res.status).toBe(200);
    expect(conversation().status).toBe("bot");
  });

  it("Q: repetir a mesma ação é idempotente (conversa já human / já bot)", async () => {
    await patch("assume");
    expect(await (await patch("assume")).json()).toMatchObject({ status: "human", changed: false });
    await patch("return");
    expect(await (await patch("return")).json()).toMatchObject({ status: "bot", changed: false });
  });

  it("conversa encerrada não é 'devolvida' — o estado não muda por engano", async () => {
    seedConversation("closed");
    const res = await patch("return");
    expect(res.status).toBe(409);
    expect(conversation().status).toBe("closed");
  });

  it("action inválida é recusada — não existe transição implícita de estado", async () => {
    const res = await patch("retomar_automatico");

    expect(res.status).toBe(400);
    expect(conversation().status).toBe("handoff");
  });

  it("L: sem sessão válida do responsável, nenhuma ação é aplicada", async () => {
    seedConversation("human");
    actor = null;
    const res = await patch("return");
    expect(res.status).toBe(401);
    expect(conversation().status).toBe("human");
  });
});

// OT-BETA-01: isolamento multi-tenant. A rota nunca lê establishmentId de
// outro lugar além da sessão; a leitura/gravação é sempre escopada por
// establishments/{id}/conversations/{conversationId}.
describe("isolamento entre estabelecimentos (OT-BETA-01)", () => {
  it("GET sempre consulta o tenant da sessão", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).conversation).toMatchObject({ id: CONV, establishmentId: "est_odonto" });
  });

  it("conversationId que só existe em OUTRO tenant -> 404, sem vazar dado", async () => {
    const res = await get("conv_de_outro_tenant");

    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("est_");
  });

  it("P: responsável do tenant B não assume nem devolve a conversa do tenant A", async () => {
    fakeDb.col("establishments/est_odonto/conversations").clear();
    seedConversation("human", {}, "est_a");
    actor = { establishmentId: "est_b", uid: "owner-b" };

    expect((await patch("return")).status).toBe(404);
    expect((await patch("assume")).status).toBe(404);
    expect(conversation("est_a").status).toBe("human");
    expect(fakeDb.col("establishments/est_b/conversations").size).toBe(0);
  });
});
