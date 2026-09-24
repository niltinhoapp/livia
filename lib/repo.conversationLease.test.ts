import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  alreadyProcessed,
  completeWhatsAppInboundJob,
  enqueueWhatsAppInboundJob,
  failWhatsAppInboundJob,
  listRecoverableWhatsAppInboundJobs,
  listWhatsAppInboundJobs,
  quarantineOrphanWhatsAppInboundJobs,
  quarantineWhatsAppInboundSequenceGap,
  releaseConversationProcessingLease,
  releaseConversationProcessingLeaseIfDrained,
  renewConversationProcessingLease,
  setConversationStatus,
  transitionConversationStatusWithLease,
  tryAcquireConversationProcessingLease,
} from "@/lib/repo";
import type { WhatsAppInboundJob } from "@/types";

const EST = "est-a";
const CONVERSATION = "5514990000000";
const path = `establishments/${EST}/conversations`;

beforeEach(() => {
  fakeDb.reset();
  fakeDb.col(path).set(CONVERSATION, {
    id: CONVERSATION,
    establishmentId: EST,
    contactPhone: CONVERSATION,
    contactName: null,
    status: "bot",
    lastMessageAt: 0,
    createdAt: 0,
  });
});

describe("lease distribuída do processamento de conversa", () => {
  it("duas mensagens simultâneas da mesma conversa têm exatamente um dono", async () => {
    const results = await Promise.all([
      tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "a" }),
      tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "b" }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("conversas diferentes continuam independentes", async () => {
    fakeDb.col(path).set("5514990000001", {
      id: "5514990000001", establishmentId: EST, contactPhone: "5514990000001", contactName: null, status: "bot", lastMessageAt: 0, createdAt: 0,
    });
    await expect(Promise.all([
      tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "a" }),
      tryAcquireConversationProcessingLease(EST, "5514990000001", { now: 100, leaseId: "b" }),
    ])).resolves.toEqual(["a", "b"]);
  });

  it("lease abandonado expira e pode ser recuperado sem aceitar o dono antigo", async () => {
    await expect(tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, ttlMs: 50, leaseId: "old" })).resolves.toBe("old");
    await expect(tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 149, leaseId: "new" })).resolves.toBeNull();
    await expect(tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 150, leaseId: "new" })).resolves.toBe("new");
    await expect(renewConversationProcessingLease(EST, CONVERSATION, "old", { now: 151 })).resolves.toBe(false);
  });

  it("libera o lease em falha sem liberar lease adquirido depois", async () => {
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, ttlMs: 10, leaseId: "old" });
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 110, leaseId: "new" });
    await releaseConversationProcessingLease(EST, CONVERSATION, "old");
    await expect(tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 111, leaseId: "third" })).resolves.toBeNull();
    await releaseConversationProcessingLease(EST, CONVERSATION, "new");
    await expect(tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 111, leaseId: "third" })).resolves.toBe("third");
  });

  it("handoff revoga atomicamente o owner e voltar ao bot não revive o turno antigo", async () => {
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "old" });
    await setConversationStatus(EST, CONVERSATION, "human");
    await setConversationStatus(EST, CONVERSATION, "bot");
    await expect(renewConversationProcessingLease(EST, CONVERSATION, "old", { now: 101 })).resolves.toBe(false);
    await expect(tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 101, leaseId: "new" })).resolves.toBe("new");
  });

  it("owner do drain pode renovar em human/handoff sem autorizar automação", async () => {
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "owner" });
    const current = fakeDb.col(path).get(CONVERSATION)!;
    fakeDb.col(path).set(CONVERSATION, { ...current, status: "human" });

    await expect(renewConversationProcessingLease(EST, CONVERSATION, "owner", { now: 101 }))
      .resolves.toBe(false);
    await expect(renewConversationProcessingLease(EST, CONVERSATION, "owner", {
      now: 101,
      allowNonAutomatedStatus: true,
    })).resolves.toBe(true);
  });
});

describe("inbox durável de mensagens inbound", () => {
  const queued = (id: string, text: string) => enqueueWhatsAppInboundJob({
    waMessageId: id,
    establishmentId: EST,
    conversationId: CONVERSATION,
    whatsappPhoneNumberId: "pn",
    value: { metadata: { phone_number_id: "pn" } },
    message: { id, from: CONVERSATION, type: "text", text: { body: text } },
    now: 100,
  });

  beforeEach(() => {
    fakeDb.reset();
    fakeDb.col(path).set(CONVERSATION, {
      id: CONVERSATION, establishmentId: EST, contactPhone: CONVERSATION,
      contactName: null, status: "bot", lastMessageAt: 0, createdAt: 0,
    });
  });

  it("duas mensagens concorrentes recebem sequência única e nenhuma é perdida", async () => {
    await Promise.all([queued("wamid.a", "Quero às 15h"), queued("wamid.b", "Não, melhor às 16h")]);
    const jobs = await listWhatsAppInboundJobs(EST, CONVERSATION);
    expect(jobs.map((job) => job.id)).toEqual(["wamid.a", "wamid.b"]);
    expect(jobs.map((job) => job.sequence)).toEqual([1, 2]);
  });

  it("retry do mesmo wamid converge no mesmo job", async () => {
    await Promise.all([queued("wamid.same", "oi"), queued("wamid.same", "oi")]);
    expect(await listWhatsAppInboundJobs(EST, CONVERSATION)).toHaveLength(1);
  });

  it("recebido não é processado; crash mantém job recuperável até conclusão", async () => {
    await queued("wamid.crash", "amanhã");
    expect(await alreadyProcessed("wamid.crash")).toBe(false);
    const [job] = await listWhatsAppInboundJobs(EST, CONVERSATION);
    expect(job).toBeDefined();

    // Simula nova invocação após crash: o documento continua sendo a fila.
    const recovered = (await listWhatsAppInboundJobs(EST, CONVERSATION))[0] as WhatsAppInboundJob;
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "recovery" });
    await completeWhatsAppInboundJob(recovered, "recovery", { now: 101 });
    expect(await alreadyProcessed("wamid.crash")).toBe(true);
    expect(await listWhatsAppInboundJobs(EST, CONVERSATION)).toHaveLength(0);
  });

  it("owner não libera na fronteira enquanto existe recebimento pendente", async () => {
    await queued("wamid.pending", "às 15h");
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "owner" });
    await expect(releaseConversationProcessingLeaseIfDrained(EST, CONVERSATION, "owner")).resolves.toBe(false);
    const [job] = await listWhatsAppInboundJobs(EST, CONVERSATION);
    await completeWhatsAppInboundJob(job!, "owner", { now: 101 });
    await expect(releaseConversationProcessingLeaseIfDrained(EST, CONVERSATION, "owner")).resolves.toBe(true);
  });

  it("owner expirado não conclui nem apaga job retomado por outro owner", async () => {
    await queued("wamid.fenced", "oi");
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, ttlMs: 10, leaseId: "old" });
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 110, ttlMs: 1_000, leaseId: "new" });
    const [job] = await listWhatsAppInboundJobs(EST, CONVERSATION);

    await expect(completeWhatsAppInboundJob(job!, "old", { now: 111 })).resolves.toBe(false);
    expect(await alreadyProcessed("wamid.fenced")).toBe(false);
    expect(await listWhatsAppInboundJobs(EST, CONVERSATION)).toHaveLength(1);

    await expect(completeWhatsAppInboundJob(job!, "new", { now: 111 })).resolves.toBe(true);
    expect(await alreadyProcessed("wamid.fenced")).toBe(true);
  });

  it("não avança o watermark pulando um job anterior", async () => {
    await queued("wamid.first", "primeira");
    await queued("wamid.second", "segunda");
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "owner" });
    const jobs = await listWhatsAppInboundJobs(EST, CONVERSATION);

    await expect(completeWhatsAppInboundJob(jobs[1]!, "owner", { now: 101 })).resolves.toBe(false);
    expect(await listWhatsAppInboundJobs(EST, CONVERSATION)).toHaveLength(2);
    await expect(completeWhatsAppInboundJob(jobs[0]!, "owner", { now: 101 })).resolves.toBe(true);
    await expect(completeWhatsAppInboundJob(jobs[1]!, "owner", { now: 101 })).resolves.toBe(true);
  });

  it("poison job recebe backoff e depois vai para dead-letter sem bloquear a sequência", async () => {
    await queued("wamid.poison", "quebra");
    const [job] = await listWhatsAppInboundJobs(EST, CONVERSATION);
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "owner" });

    await expect(failWhatsAppInboundJob(job!, "owner", "provider_failure", { now: 101, maxAttempts: 2 }))
      .resolves.toBe("retry_scheduled");
    expect((await listWhatsAppInboundJobs(EST, CONVERSATION))[0]?.nextAttemptAt).toBeGreaterThan(101);
    expect(await listRecoverableWhatsAppInboundJobs(10, 102)).toHaveLength(0);

    await expect(failWhatsAppInboundJob(job!, "owner", "provider_failure", { now: 60_101, maxAttempts: 2 }))
      .resolves.toBe("dead_letter");
    expect(await listWhatsAppInboundJobs(EST, CONVERSATION)).toHaveLength(0);
    expect(fakeDb.col("_wa_inbound_dead_letters").has("wamid.poison")).toBe(true);
    expect(await alreadyProcessed("wamid.poison")).toBe(true);
  });

  it("backoff de jobs quebrados não causa starvation global", async () => {
    await queued("wamid.poison", "quebra");
    fakeDb.col(path).set("5514990000001", {
      id: "5514990000001", establishmentId: EST, contactPhone: "5514990000001", status: "bot", lastMessageAt: 0, createdAt: 0,
    });
    await enqueueWhatsAppInboundJob({
      waMessageId: "wamid.healthy", establishmentId: EST, conversationId: "5514990000001", whatsappPhoneNumberId: "pn",
      value: {}, message: { id: "wamid.healthy" }, now: 102,
    });
    const poison = (await listWhatsAppInboundJobs(EST, CONVERSATION))[0]!;
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "owner" });
    await failWhatsAppInboundJob(poison, "owner", "provider_failure", { now: 101 });

    await expect(listRecoverableWhatsAppInboundJobs(10, 103)).resolves.toEqual([
      expect.objectContaining({ id: "wamid.healthy" }),
    ]);
  });

  it("conversa apagada move jobs órfãos para dead-letter", async () => {
    await queued("wamid.orphan", "oi");
    fakeDb.col(path).delete(CONVERSATION);
    await expect(quarantineOrphanWhatsAppInboundJobs(EST, CONVERSATION, 200)).resolves.toBe(1);
    expect(fakeDb.col("_wa_inbound_jobs").has("wamid.orphan")).toBe(false);
    expect(fakeDb.col("_wa_inbound_dead_letters").has("wamid.orphan")).toBe(true);
  });

  it("inconsistência entre contador e jobs é quarentenada sem loop apertado", async () => {
    const current = fakeDb.col(path).get(CONVERSATION)!;
    fakeDb.col(path).set(CONVERSATION, { ...current, inboundSequence: 2, processedInboundSequence: 0 });
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "owner" });
    await expect(quarantineWhatsAppInboundSequenceGap(EST, CONVERSATION, "owner", 101)).resolves.toBe(true);
    expect(fakeDb.col(path).get(CONVERSATION)).toMatchObject({ processedInboundSequence: 2, aiProcessingLease: null });
  });
});

describe("transições de automação nunca vencem takeover humano", () => {
  it.each([
    ["aceite humano", "bot", "handoff"],
    ["recusa de handoff", "handoff", "bot"],
    ["handoff decidido pela IA", "bot", "handoff"],
  ] as const)("%s", async (_label, initial, next) => {
    fakeDb.reset();
    fakeDb.col(path).set(CONVERSATION, {
      id: CONVERSATION, establishmentId: EST, contactPhone: CONVERSATION, status: initial, lastMessageAt: 0, createdAt: 0,
    });
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { now: 100, leaseId: "turn" });
    await setConversationStatus(EST, CONVERSATION, "human");
    await expect(transitionConversationStatusWithLease(EST, CONVERSATION, "turn", initial, next, { now: 101 }))
      .resolves.toBe(false);
    expect(fakeDb.col(path).get(CONVERSATION)?.status).toBe("human");
  });
});
