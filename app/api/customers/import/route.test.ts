import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveEstablishmentId = vi.hoisted(() => vi.fn());
const importMarketingContacts = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({ resolveEstablishmentId }));
vi.mock("@/lib/repo", () => ({ importMarketingContacts }));

import { POST } from "./route";

beforeEach(() => {
  resolveEstablishmentId.mockReset();
  importMarketingContacts.mockReset();
  resolveEstablishmentId.mockResolvedValue("establishment-a");
  importMarketingContacts.mockResolvedValue({ created: 1 });
});

describe("POST /api/customers/import", () => {
  it("resolve o tenant pela sessão e ignora establishmentId arbitrário do corpo", async () => {
    const req = new Request("http://localhost/api/customers/import", {
      method: "POST",
      body: JSON.stringify({
        establishmentId: "establishment-b",
        contacts: [{ phone: "5514996447132" }],
        declaration: { confirmedMarketingOptIn: true, source: "crm_import" },
      }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(importMarketingContacts).toHaveBeenCalledWith("establishment-a", expect.objectContaining({
      contacts: [{ phone: "5514996447132" }],
    }));
  });

  it("rejeita payload sem declaração antes de chamar o domínio", async () => {
    const req = new Request("http://localhost/api/customers/import", {
      method: "POST", body: JSON.stringify({ contacts: [{ phone: "5514996447132" }] }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(importMarketingContacts).not.toHaveBeenCalled();
  });

  it("não aceita consentimento falso como elegibilidade", async () => {
    const req = new Request("http://localhost/api/customers/import", {
      method: "POST",
      body: JSON.stringify({
        contacts: [{ phone: "5514996447132" }],
        declaration: { confirmedMarketingOptIn: false, source: "whatsapp" },
      }),
    });
    importMarketingContacts.mockRejectedValueOnce(new Error("Declaração explícita de opt-in é obrigatória."));
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(importMarketingContacts).toHaveBeenCalledWith("establishment-a", expect.objectContaining({
      declaration: { confirmedMarketingOptIn: false, source: "whatsapp" },
    }));
  });
});
