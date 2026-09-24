import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { AutomationFenceError } from "@/lib/automationFence";
import { bookAppointment, defaultScheduleConfig, listAppointments } from "@/lib/scheduling";
import { confirmOrder } from "@/lib/orders";
import { setConversationStatus, tryAcquireConversationProcessingLease } from "@/lib/repo";
import type { FoodOrder } from "@/types";

const EST = "est-fence";
const CONVERSATION = "5514990000000";
const conversationPath = `establishments/${EST}/conversations`;

beforeEach(() => {
  fakeDb.reset();
  fakeDb.col("establishments").set(EST, {
    id: EST, name: "Fence", type: "food", ownerUid: "owner", status: "active", createdAt: 0,
    bot: { personaName: "Livia", tone: "", bookingEnabled: true, ordersEnabled: true, medicalGuardrail: false },
  });
  fakeDb.col(conversationPath).set(CONVERSATION, {
    id: CONVERSATION, establishmentId: EST, contactPhone: CONVERSATION,
    contactName: null, status: "bot", lastMessageAt: 0, createdAt: 0,
  });
});

describe("fencing transacional de turnos da IA", () => {
  it("lease expirado e novo owner impedem o owner antigo de criar agendamento", async () => {
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { leaseId: "old", now: 100, ttlMs: 10 });
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { leaseId: "new", now: 110, ttlMs: 1_000 });
    const config = { ...defaultScheduleConfig(EST), leadHours: 0 };
    const startAt = Date.UTC(2026, 8, 28, 15, 0);

    await expect(bookAppointment(EST, config, {
      contactPhone: CONVERSATION, contactName: null, serviceName: "Corte",
      startAt, durationMin: 30, source: "bot",
    }, 111, { conversationId: CONVERSATION, leaseId: "old" })).rejects.toBeInstanceOf(AutomationFenceError);
    await expect(listAppointments(EST, startAt - 1, startAt + 1)).resolves.toHaveLength(0);
  });

  it("handoff entre validação e commit bloqueia a mutação; bot posterior não revive o turno", async () => {
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { leaseId: "turn", now: 100, ttlMs: 10_000 });
    await setConversationStatus(EST, CONVERSATION, "human");
    await setConversationStatus(EST, CONVERSATION, "bot");
    const config = { ...defaultScheduleConfig(EST), leadHours: 0 };
    const startAt = Date.UTC(2026, 8, 28, 16, 0);

    await expect(bookAppointment(EST, config, {
      contactPhone: CONVERSATION, contactName: null, serviceName: "Corte",
      startAt, durationMin: 30, source: "bot",
    }, 101, { conversationId: CONVERSATION, leaseId: "turn" })).rejects.toBeInstanceOf(AutomationFenceError);
  });

  it("pedido também valida o fencing no mesmo commit financeiro/operacional", async () => {
    await tryAcquireConversationProcessingLease(EST, CONVERSATION, { leaseId: "order-turn", now: 100, ttlMs: 10_000 });
    const order: FoodOrder = {
      id: "order-1", establishmentId: EST, conversationId: CONVERSATION,
      contactPhone: CONVERSATION, contactName: null, status: "awaiting_confirmation",
      fulfillment: "pickup", deliveryAddress: null, deliveryFeeCents: 0, discountCents: 0,
      payment: { method: "cash", status: "unpaid", changeForCents: null }, items: [],
      subtotalCents: 0, totalCents: 0, version: 1, confirmationRequestedAt: 1,
      snapshot: null, createdAt: 1, updatedAt: 1, confirmedAt: null,
    };
    fakeDb.col(`establishments/${EST}/orders`).set(order.id, order as unknown as Record<string, unknown>);
    await setConversationStatus(EST, CONVERSATION, "human");

    await expect(confirmOrder(EST, order.id, 1, CONVERSATION, "op", {
      conversationId: CONVERSATION, leaseId: "order-turn",
    })).rejects.toBeInstanceOf(AutomationFenceError);
    expect((fakeDb.col(`establishments/${EST}/orders`).get(order.id) as unknown as FoodOrder).status).toBe("awaiting_confirmation");
  });
});
