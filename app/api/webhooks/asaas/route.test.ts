import { describe, expect, it, vi, beforeEach } from "vitest";

const TOKEN = "segredo-de-teste-do-webhook-com-mais-de-32-caracteres";
process.env.ASAAS_WEBHOOK_TOKEN = TOKEN;

const processAsaasWebhookEvent = vi.fn();
const createAsaasWebhookProcessingDependencies = vi.fn(async () => ({}));

vi.mock("@/lib/billing/asaasWebhookProcessing", () => ({
  processAsaasWebhookEvent: (...a: unknown[]) => processAsaasWebhookEvent(...a),
  createAsaasWebhookProcessingDependencies: () => createAsaasWebhookProcessingDependencies(),
}));

import { POST } from "./route";

function post(body: unknown, headers: Record<string, string> = { "asaas-access-token": TOKEN }) {
  const req = new Request("https://livia.test/api/webhooks/asaas", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return POST(req as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  processAsaasWebhookEvent.mockResolvedValue({ outcome: "ignored", event: "X" });
});

// ---- Política HTTP (OT-06C.1) ----
// 200 -> decisão já durável (aplicada ou deliberadamente descartada)
// 400 -> autenticado, mas não é um envelope Asaas válido
// 401 -> token ausente/incorreto
// 503 -> falha transitória ANTES de garantir persistência (nunca confirma
//        um evento financeiro que pode não ter sido aplicado)

describe("token ausente/incorreto -> 401 (nunca mascarado como sucesso)", () => {
  it("token ausente: 401, não processa", async () => {
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED" }, {});
    expect(res.status).toBe(401);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
  });

  it("token incorreto (tamanho diferente): 401, não processa", async () => {
    const res = await post(
      { id: "evt_1", event: "PAYMENT_RECEIVED" },
      { "asaas-access-token": "token-forjado-com-tamanho-diferente" },
    );
    expect(res.status).toBe(401);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
  });

  it("token incorreto (mesmo tamanho): 401, não processa", async () => {
    const forjado = "x".repeat(TOKEN.length);
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED" }, { "asaas-access-token": forjado });
    expect(res.status).toBe(401);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
  });

  it("nunca usa ASAAS_API_KEY como fallback de autenticação", async () => {
    process.env.ASAAS_API_KEY = "$aact_hmlg_ALGUM_VALOR_REAL_AQUI";
    const res = await post(
      { id: "evt_1", event: "PAYMENT_RECEIVED" },
      { "asaas-access-token": process.env.ASAAS_API_KEY },
    );
    expect(res.status).toBe(401);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
    delete process.env.ASAAS_API_KEY;
  });

  it("ASAAS_WEBHOOK_TOKEN não configurado: 401, mesmo com header presente", async () => {
    const original = process.env.ASAAS_WEBHOOK_TOKEN;
    delete process.env.ASAAS_WEBHOOK_TOKEN;
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED" }, { "asaas-access-token": TOKEN });
    expect(res.status).toBe(401);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
    process.env.ASAAS_WEBHOOK_TOKEN = original;
  });

  it("corpo de erro não vaza o token nem detalhe interno", async () => {
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED" }, {});
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({ error: "UNAUTHENTICATED" });
  });
});

describe("payload inválido -> 400 (autenticado, mas não é um envelope Asaas)", () => {
  it("corpo não é JSON válido: 400, não processa", async () => {
    const req = new Request("https://livia.test/api/webhooks/asaas", {
      method: "POST",
      headers: { "content-type": "application/json", "asaas-access-token": TOKEN },
      body: "{ isto não é json",
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
  });

  it("JSON válido mas envelope Asaas inválido (processAsaasWebhookEvent retorna invalid_envelope) -> 400", async () => {
    processAsaasWebhookEvent.mockResolvedValue({ outcome: "invalid_envelope" });
    const res = await post({ not: "an envelope" });
    expect(res.status).toBe(400);
    expect(processAsaasWebhookEvent).toHaveBeenCalledWith({ not: "an envelope" }, expect.anything());
  });
});

describe("decisão durável -> 200 (aplicada ou deliberadamente descartada)", () => {
  it.each([
    ["applied", { outcome: "applied", event: "PAYMENT_CONFIRMED", establishmentId: "e", generation: 1, from: "trial", to: "active" }],
    ["duplicate", { outcome: "duplicate", eventId: "evt_1" }],
    ["ignored (evento desconhecido ou SUBSCRIPTION_INACTIVATED)", { outcome: "ignored", event: "SUBSCRIPTION_INACTIVATED" }],
    ["unresolved_identity", { outcome: "unresolved_identity", event: "PAYMENT_RECEIVED" }],
    ["establishment_not_found", { outcome: "establishment_not_found", event: "PAYMENT_RECEIVED", establishmentId: "e", generation: 1 }],
    ["billing_not_initialized", { outcome: "billing_not_initialized", event: "PAYMENT_RECEIVED", establishmentId: "e", generation: 1 }],
    ["out_of_order", { outcome: "out_of_order", event: "PAYMENT_RECEIVED", establishmentId: "e", generation: 1 }],
    ["invalid_transition", { outcome: "invalid_transition", event: "PAYMENT_OVERDUE", establishmentId: "e", generation: 1, from: "canceled" }],
  ])("%s -> 200", async (_label, result) => {
    processAsaasWebhookEvent.mockResolvedValue(result);
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED", dateCreated: "2026-09-16 10:00:00" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });
});

describe("falha transitória/interna ANTES de garantir persistência -> 503, nunca 200", () => {
  it("exceção em createAsaasWebhookProcessingDependencies (ex.: Firestore indisponível) -> 503", async () => {
    createAsaasWebhookProcessingDependencies.mockRejectedValueOnce(new Error("firestore indisponível"));
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED", dateCreated: "2026-09-16 10:00:00" });
    expect(res.status).toBe(503);
    expect(res.status).not.toBe(200);
  });

  it("exceção em processAsaasWebhookEvent -> 503, nunca confirma sucesso falso", async () => {
    processAsaasWebhookEvent.mockRejectedValueOnce(new Error("erro inesperado durante persistência"));
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED", dateCreated: "2026-09-16 10:00:00" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "PROCESSING_FAILED" });
  });

  it("corpo do erro 503 não vaza detalhe interno/stack/segredo", async () => {
    processAsaasWebhookEvent.mockRejectedValueOnce(new Error(`falha com token vazando: ${TOKEN}`));
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED", dateCreated: "2026-09-16 10:00:00" });
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("falha com token vazando");
  });

  it("uma exceção do Firestore durante um PAYMENT_CONFIRMED real nunca é confirmada como sucesso", async () => {
    // Este é o cenário central da OT-06C.1: um evento financeiro genuíno
    // que falhou ANTES de persistir não pode, de jeito nenhum, receber 200 —
    // senão a Asaas nunca reenvia, e o billingStatus fica desatualizado
    // permanentemente sem que ninguém saiba.
    processAsaasWebhookEvent.mockRejectedValueOnce(new Error("DEADLINE_EXCEEDED"));
    const res = await post({
      id: "evt_financeiro_real",
      event: "PAYMENT_CONFIRMED",
      dateCreated: "2026-09-16 10:00:00",
      payment: { id: "pay_1", externalReference: "livia:subscription:est_1:1" },
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
  });
});
