import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
import { toolsFor } from "./tools";
import type { ToolContext } from "./tools";

describe("F4: Bloqueio de Tools na Prospecção", () => {
  const baseCtx: any = {
    est: { bot: { bookingEnabled: true, ordersEnabled: true } },
    config: {},
  };

  it("1. sem prospectingContext -> tools mutáveis continuam presentes", () => {
    const tools = toolsFor(baseCtx);
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("create_appointment");
    expect(names).toContain("add_order_item");
    expect(names).toContain("update_customer_profile");
    expect(names).toContain("request_human_handoff");
  });

  it("2. com prospectingContext -> tools mutáveis são removidas, request_handoff fica", () => {
    const ctx: any = {
      ...baseCtx,
      prospectingContext: { status: "LIVIA_ACTIVE", initialManualMessage: "Oi" },
    };
    const tools = toolsFor(ctx);
    const names = tools.map((t) => t.function.name);
    
    // Tools informativas devem continuar
    expect(names).toContain("request_human_handoff");
    expect(names).toContain("update_prospecting_status");
    
    // Tools bloqueadas
    expect(names).not.toContain("create_appointment");
    expect(names).not.toContain("cancel_appointment");
    expect(names).not.toContain("reschedule_appointment");
    expect(names).not.toContain("add_order_item");
    expect(names).not.toContain("update_customer_profile");
    expect(names).not.toContain("add_order_item");
    expect(names).not.toContain("update_customer_profile");
    expect(names).not.toContain("confirm_order");
  });
});
