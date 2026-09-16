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

describe("autenticação", () => {
  it("token válido: processa e responde 200", async () => {
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED", dateCreated: "2026-09-16 10:00:00" });
    expect(res.status).toBe(200);
    expect(processAsaasWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it("token ausente: responde 200 mas NÃO processa (fail-closed, sem retry storm)", async () => {
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED" }, {});
    expect(res.status).toBe(200);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
  });

  it("token incorreto: responde 200 mas NÃO processa", async () => {
    const res = await post(
      { id: "evt_1", event: "PAYMENT_RECEIVED" },
      { "asaas-access-token": "token-forjado-com-tamanho-diferente" },
    );
    expect(res.status).toBe(200);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
  });

  it("token do mesmo tamanho mas incorreto: responde 200 mas NÃO processa", async () => {
    const forjado = "x".repeat(TOKEN.length);
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED" }, { "asaas-access-token": forjado });
    expect(res.status).toBe(200);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
  });

  it("nunca usa ASAAS_API_KEY como fallback de autenticação", async () => {
    process.env.ASAAS_API_KEY = "$aact_hmlg_ALGUM_VALOR_REAL_AQUI";
    const res = await post(
      { id: "evt_1", event: "PAYMENT_RECEIVED" },
      { "asaas-access-token": process.env.ASAAS_API_KEY },
    );
    expect(res.status).toBe(200);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
    delete process.env.ASAAS_API_KEY;
  });

  it("ASAAS_WEBHOOK_TOKEN não configurado: nunca autentica, mesmo com header presente", async () => {
    const original = process.env.ASAAS_WEBHOOK_TOKEN;
    delete process.env.ASAAS_WEBHOOK_TOKEN;
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED" }, { "asaas-access-token": TOKEN });
    expect(res.status).toBe(200);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
    process.env.ASAAS_WEBHOOK_TOKEN = original;
  });
});

describe("payload inválido", () => {
  it("corpo não é JSON válido: responde 200, não processa, não lança", async () => {
    const req = new Request("https://livia.test/api/webhooks/asaas", {
      method: "POST",
      headers: { "content-type": "application/json", "asaas-access-token": TOKEN },
      body: "{ isto não é json",
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(processAsaasWebhookEvent).not.toHaveBeenCalled();
  });

  it("JSON válido mas envelope inválido: repassa para processAsaasWebhookEvent (validação estrutural vive lá)", async () => {
    processAsaasWebhookEvent.mockResolvedValue({ outcome: "invalid_envelope" });
    const res = await post({ not: "an envelope" });
    expect(res.status).toBe(200);
    expect(processAsaasWebhookEvent).toHaveBeenCalledWith({ not: "an envelope" }, expect.anything());
  });
});

describe("erro interno nunca vira não-2xx", () => {
  it("exceção em createAsaasWebhookProcessingDependencies não derruba a resposta 200", async () => {
    createAsaasWebhookProcessingDependencies.mockRejectedValueOnce(new Error("firestore indisponível"));
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED", dateCreated: "2026-09-16 10:00:00" });
    expect(res.status).toBe(200);
  });

  it("exceção em processAsaasWebhookEvent não derruba a resposta 200", async () => {
    processAsaasWebhookEvent.mockRejectedValueOnce(new Error("erro inesperado"));
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED", dateCreated: "2026-09-16 10:00:00" });
    expect(res.status).toBe(200);
  });
});

describe("resposta nunca vaza dado sensível", () => {
  it("corpo da resposta não contém o token nem detalhes de erro interno", async () => {
    processAsaasWebhookEvent.mockRejectedValueOnce(new Error(`token vazou aqui: ${TOKEN}`));
    const res = await post({ id: "evt_1", event: "PAYMENT_RECEIVED", dateCreated: "2026-09-16 10:00:00" });
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
  });
});
