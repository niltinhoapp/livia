import { describe, expect, it } from "vitest";
import { AUDIT_DEMO_ACCESS_TTL_MS, authorizeDemo, grantAuditDemoAccess } from "./demoAuthorization";

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

describe("porta da Calculadora — acesso demo próprio, sem ProspectingSession", () => {
  const PHONE = "5511999999999";
  const auditCommercial = (patch: Record<string, unknown> = {}): any => ({ purpose: "commercial", source: "audit_calculator", enteredAt: 500, updatedAt: 600, ...patch });
  const access = { leadId: `audit_${PHONE}_500`, grantedAt: NOW - 10, expiresAt: NOW + 1_000 };

  it("A5/A10: lead da Auditoria sem sessão de prospecção é autorizado pelo acesso da própria jornada", () => {
    expect(authorizeDemo(input({ session: null, leadId: "", context: auditCommercial({ demoAccess: access }) })))
      .toEqual({ authorized: true, establishmentId: "demo", prospectingLeadId: `audit_${PHONE}_500` });
  });

  it("A não depende de B: sessão de prospecção revelada do mesmo telefone NÃO autoriza uma jornada da Calculadora", () => {
    expect(authorizeDemo(input({ context: auditCommercial() })).authorized).toBe(false);
  });

  it("sem aceite (Audit), acesso vencido, lead de outro telefone ou canal errado: falha fechada", () => {
    expect(authorizeDemo(input({ session: null, context: { ...auditCommercial({ demoAccess: access }), purpose: "audit" } })).authorized).toBe(false);
    expect(authorizeDemo(input({ session: null, context: auditCommercial({ demoAccess: { ...access, expiresAt: NOW } }) })).authorized).toBe(false);
    expect(authorizeDemo(input({ session: null, context: auditCommercial({ demoAccess: { ...access, leadId: "audit_5511000000000_500" } }) })).authorized).toBe(false);
    expect(authorizeDemo(input({ session: null, internalDemoProspectingEstablishmentId: "revenue", context: auditCommercial({ demoAccess: access }) })).authorized).toBe(false);
    expect(authorizeDemo(input({ session: null, establishment: { id: "demo" }, context: auditCommercial({ demoAccess: access }) })).authorized).toBe(false);
  });

  it("B continua independente: jornada de prospecção segue autorizada pela sessão", () => {
    expect(authorizeDemo(input({ context: { purpose: "commercial", source: "prospecting", enteredAt: 1, updatedAt: 1 } })))
      .toEqual({ authorized: true, establishmentId: "demo", prospectingLeadId: "lead-1" });
  });
});

describe("grantAuditDemoAccess — sequência Audit → interesse → demo", () => {
  const base = { establishment, internalDemoProspectingEstablishmentId: "demo", phone: "5511999999999", now: NOW };

  it("durante o diagnóstico (Audit) nunca concede, mesmo com pedido", () => {
    const audit: any = { purpose: "audit", source: "audit_calculator", enteredAt: 500, updatedAt: 500 };
    expect(grantAuditDemoAccess({ ...base, context: audit, demoRequested: true })).toBe(audit);
  });

  it("depois do interesse (Commercial) concede só quando há pedido/aceite, com escopo da jornada", () => {
    const qualified: any = { purpose: "commercial", source: "audit_calculator", enteredAt: 500, updatedAt: 600 };
    expect(grantAuditDemoAccess({ ...base, context: qualified, demoRequested: false })).toBe(qualified);
    expect(grantAuditDemoAccess({ ...base, context: qualified, demoRequested: true }).demoAccess)
      .toEqual({ leadId: "audit_5511999999999_500", grantedAt: NOW, expiresAt: NOW + AUDIT_DEMO_ACCESS_TTL_MS });
  });

  it("nunca concede fora do canal demo oficial nem para jornada de prospecção", () => {
    const qualified: any = { purpose: "commercial", source: "audit_calculator", enteredAt: 500, updatedAt: 600 };
    expect(grantAuditDemoAccess({ ...base, internalDemoProspectingEstablishmentId: "revenue", context: qualified, demoRequested: true })).toBe(qualified);
    const prospecting: any = { purpose: "commercial", source: "prospecting", enteredAt: 1, updatedAt: 1 };
    expect(grantAuditDemoAccess({ ...base, context: prospecting, demoRequested: true })).toBe(prospecting);
  });
});
