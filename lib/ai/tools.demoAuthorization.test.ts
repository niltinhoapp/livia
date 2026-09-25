import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
import { toolsFor } from "./tools";

const names = (ctx: any) => toolsFor(ctx).map((tool: any) => tool.function.name);
const base = { est: { bot: { bookingEnabled: true, ordersEnabled: true } }, config: {}, contactPhone: "5511999999999", contactName: null, offset: -180, customerProfile: null };
const prospect = { status: "REVEALED", leadId: "lead-1" };

describe("tools de pedido no Prospect", () => {
  it("libera mutações somente com DemoAuthorization válida", () => {
    expect(names({ ...base, prospectingContext: prospect, demoAuthorization: { authorized: true, establishmentId: "demo", prospectingLeadId: "lead-1" } })).toContain("add_order_item");
  });
  it("bloqueia Prospect sem autorização ou com autorização negativa", () => {
    expect(names({ ...base, prospectingContext: prospect })).not.toContain("add_order_item");
    expect(names({ ...base, prospectingContext: prospect, demoAuthorization: { authorized: false } })).not.toContain("add_order_item");
  });
  it("mantém conversa comercial normal e leitura de cardápio", () => {
    expect(names(base)).toContain("add_order_item");
    expect(names({ ...base, prospectingContext: prospect })).toContain("list_menu");
  });
  it("libera agenda demo somente com a autorização forte", () => {
    const authorized = names({ ...base, prospectingContext: prospect, demoAuthorization: { authorized: true, establishmentId: "demo", prospectingLeadId: "lead-1" } });
    expect(authorized).toContain("create_appointment");
    expect(authorized).toContain("reschedule_appointment");
    expect(authorized).toContain("cancel_appointment");
    expect(names({ ...base, prospectingContext: prospect })).not.toContain("create_appointment");
  });
});
