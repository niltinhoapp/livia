import { describe, expect, it } from "vitest";
import { authorizeDemo } from "./demoAuthorization";

const NOW = 1_000_000;
const establishment: any = { id: "demo", demoChannel: { enabled: true } };
const session: any = { establishmentId: "demo", normalizedPhone: "5511999999999", leadId: "lead-1", expiresAt: NOW + 1, status: "REVEALED" };
const input = (patch: Record<string, unknown> = {}) => ({ establishment, internalDemoProspectingEstablishmentId: "demo", session, phone: "5511999999999", leadId: "lead-1", now: NOW, ...patch });

describe("authorizeDemo", () => {
  it("autoriza todas as provas válidas", () => expect(authorizeDemo(input())).toEqual({ authorized: true, establishmentId: "demo", prospectingLeadId: "lead-1" }));
  it("recusa estabelecimento Revenue; só o ID Demo autoriza", () => expect(authorizeDemo(input({ internalDemoProspectingEstablishmentId: "revenue" })).authorized).toBe(false));
  it("recusa canal demo ausente ou desativado", () => { expect(authorizeDemo(input({ establishment: { id: "demo" } })).authorized).toBe(false); expect(authorizeDemo(input({ establishment: { id: "demo", demoChannel: { enabled: false } } })).authorized).toBe(false); });
  it("recusa sessão ausente", () => expect(authorizeDemo(input({ session: null })).authorized).toBe(false));
  it("recusa sessão expirada", () => expect(authorizeDemo(input({ session: { ...session, expiresAt: NOW } })).authorized).toBe(false));
  it("recusa estado não permitido", () => expect(authorizeDemo(input({ session: { ...session, status: "LIVIA_ACTIVE" } })).authorized).toBe(false));
  it("recusa lead diferente", () => expect(authorizeDemo(input({ leadId: "other" })).authorized).toBe(false));
});
