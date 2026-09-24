// Dedupe de mensagem do WhatsApp — prova de ATOMICIDADE, não só de
// "segunda chamada devolve duplicado" (isso já valia antes da correção).
//
// A propriedade que interessa: duas execuções CONCORRENTES da mesma
// mensagem não podem, as duas, adquirir o id. Se pudessem, a Lívia
// responderia duas vezes e uma ferramenta de escrita (create_appointment)
// poderia rodar duas vezes.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { alreadyProcessed, completeWhatsAppInboundJob, enqueueWhatsAppInboundJob, listWhatsAppInboundJobs, tryAcquireConversationProcessingLease } from "@/lib/repo";

const MSG = "wamid.HBgNNTUxNDk5MTIzNDU2NxUCABIYFjNBMEE";

beforeEach(() => {
  fakeDb.reset();
  fakeDb.col("establishments/est/conversations").set("conv", {
    id: "conv", establishmentId: "est", contactPhone: "5511", contactName: null,
    status: "bot", lastMessageAt: 0, createdAt: 0,
  });
});

const enqueue = (id: string) => enqueueWhatsAppInboundJob({
  waMessageId: id, establishmentId: "est", conversationId: "conv",
  whatsappPhoneNumberId: "pn",
  value: {}, message: { id }, now: 1,
});

describe("CRÍTICO 2 — dedupe separa recebimento de conclusão", () => {
  it("mensagem nova ainda não está concluída", async () => {
    expect(await alreadyProcessed(MSG)).toBe(false);
  });

  it("receber duas vezes mantém um job; só conclusão marca processado", async () => {
    expect(await alreadyProcessed(MSG)).toBe(false);
    await enqueue(MSG);
    await enqueue(MSG);
    const [job] = await listWhatsAppInboundJobs("est", "conv");
    expect(await listWhatsAppInboundJobs("est", "conv")).toHaveLength(1);
    expect(await alreadyProcessed(MSG)).toBe(false);
    await tryAcquireConversationProcessingLease("est", "conv", { now: 1, leaseId: "owner" });
    await completeWhatsAppInboundJob(job!, "owner", { now: 2 });
    expect(await alreadyProcessed(MSG)).toBe(true);
  });

  it("CONCORRÊNCIA: entre N recebimentos simultâneos existe exatamente um job", async () => {
    await Promise.all(Array.from({ length: 8 }, () => enqueue(MSG)));
    expect(await listWhatsAppInboundJobs("est", "conv")).toHaveLength(1);
  });

  it("CONCORRÊNCIA: quantas mensagens distintas, tantos jobs", async () => {
    const ids = ["wamid.A", "wamid.B", "wamid.C"];
    await Promise.all([...ids, ...ids].map(enqueue));
    expect(await listWhatsAppInboundJobs("est", "conv")).toHaveLength(3);
  });

  it("mensagens diferentes nunca colidem entre si", async () => {
    expect(await alreadyProcessed("wamid.X")).toBe(false);
    expect(await alreadyProcessed("wamid.Y")).toBe(false);
  });

  it("falha depois do recebimento não transforma o job em processado", async () => {
    await enqueue(MSG);
    expect(await alreadyProcessed(MSG)).toBe(false);
    expect(await listWhatsAppInboundJobs("est", "conv")).toHaveLength(1);
  });

  it("erro de infraestrutura não é confundido com duplicado", async () => {
    vi.spyOn(fakeDb, "collection").mockReturnValueOnce({
      doc: () => ({
        get: async () => {
          throw new Error("14 UNAVAILABLE: connection reset");
        },
      }),
    } as never);

    await expect(alreadyProcessed("wamid.ERR")).rejects.toThrow("UNAVAILABLE");
    vi.restoreAllMocks();
  });
});
