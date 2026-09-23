import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  releaseConversationProcessingLease,
  renewConversationProcessingLease,
  tryAcquireConversationProcessingLease,
} from "@/lib/repo";

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
});
