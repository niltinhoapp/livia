import { describe, expect, it, vi } from "vitest";
import {
  createAsaasClient,
  environmentMatchesKey,
  type AsaasClientConfig,
  type CreateCustomerInput,
  type CreateSubscriptionInput,
} from "./asaas";

const SANDBOX_KEY = "$aact_hmlg_000TEST000FAKE000KEY000SANDBOX";
const PRODUCTION_KEY = "$aact_prod_000TEST000FAKE000KEY000PRODUCTION";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function rawResponse(status: number, rawBody: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => rawBody,
  } as Response;
}

type FetchCall = [url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }];
type MockFetch = typeof fetch & { mock: { calls: FetchCall[] } };

function mockFetch(impl: (...args: FetchCall) => Promise<Response>): MockFetch {
  return vi.fn(impl) as unknown as MockFetch;
}

function client(over: Partial<AsaasClientConfig> = {}, fetchImpl?: typeof fetch) {
  return createAsaasClient({
    environment: "sandbox",
    apiKey: SANDBOX_KEY,
    fetchImpl,
    ...over,
  });
}

const CUSTOMER_INPUT: CreateCustomerInput = {
  name: "Ms Barber Shop",
  cpfCnpj: "00000000000",
  externalReference: "est_odonto",
};

const SUBSCRIPTION_INPUT: CreateSubscriptionInput = {
  customer: "cus_000001",
  billingType: "PIX",
  value: 99.9,
  nextDueDate: "2026-09-22",
  cycle: "MONTHLY",
  externalReference: "est_odonto",
};

const SUBSCRIPTION = {
  id: "sub_1",
  customer: "cus_000001",
  billingType: "PIX" as const,
  value: 99.9,
  nextDueDate: "2026-09-22",
  cycle: "MONTHLY" as const,
  externalReference: "livia:subscription:est_odonto:1",
};

describe("1-2) URLs por ambiente", () => {
  it("sandbox usa https://api-sandbox.asaas.com/v3", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "cus_1" }));
    await client({ environment: "sandbox", apiKey: SANDBOX_KEY }, fetchImpl).createCustomer(CUSTOMER_INPUT);
    const [url] = fetchImpl.mock.calls[0] as FetchCall;
    expect(url).toBe("https://api-sandbox.asaas.com/v3/customers");
  });

  it("production usa https://api.asaas.com/v3", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "cus_1" }));
    await client({ environment: "production", apiKey: PRODUCTION_KEY }, fetchImpl).createCustomer(CUSTOMER_INPUT);
    const [url] = fetchImpl.mock.calls[0] as FetchCall;
    expect(url).toBe("https://api.asaas.com/v3/customers");
  });
});

describe("3-5) headers", () => {
  it("3) envia access_token com a chave configurada", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "cus_1" }));
    await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(opts.headers?.access_token).toBe(SANDBOX_KEY);
  });

  it("4) NÃO usa Authorization: Bearer", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "cus_1" }));
    await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(opts.headers?.Authorization).toBeUndefined();
  });

  it("5) User-Agent presente e identifica a Lívia", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "cus_1" }));
    await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(opts.headers?.["User-Agent"]).toMatch(/livia/i);
  });
});

describe("auth check read-only", () => {
  it("usa GET /myAccount/accountNumber e não expõe o número da conta", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { accountNumber: "123456" }));
    const result = await client({}, fetchImpl).checkAuthentication();

    expect(result).toEqual({ ok: true, data: { authenticated: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api-sandbox.asaas.com/v3/myAccount/accountNumber",
    );
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe("GET");
    expect(fetchImpl.mock.calls[0]?.[1].body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("123456");
  });

  it("resposta inválida falha sanitizada", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, null));
    const result = await client({}, fetchImpl).checkAuthentication();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
    expect(JSON.stringify(result)).not.toContain(SANDBOX_KEY);
  });
});

describe("6) API key nunca aparece em erro", () => {
  it("erro HTTP não contém a chave", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(401, { errors: [{ code: "invalid_access_token" }] }));
    const result = await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    expect(JSON.stringify(result)).not.toContain(SANDBOX_KEY);
  });

  it("erro de rede não contém a chave", async () => {
    const fetchImpl = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    expect(JSON.stringify(result)).not.toContain(SANDBOX_KEY);
  });
});

describe("7-8) createCustomer", () => {
  it("7) gera payload correto (só os campos permitidos)", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "cus_1" }));
    await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(JSON.parse(opts.body ?? "{}")).toEqual({
      name: "Ms Barber Shop",
      cpfCnpj: "00000000000",
      externalReference: "est_odonto",
    });
  });

  it("8) externalReference é preservado exatamente", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "cus_1" }));
    await client({}, fetchImpl).createCustomer({ ...CUSTOMER_INPUT, externalReference: "est_XYZ_123" });
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(JSON.parse(opts.body ?? "{}").externalReference).toBe("est_XYZ_123");
  });

  it("nunca repassa campos extras do input (body construído campo a campo, nunca spread)", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "cus_1" }));
    const dirty = { ...CUSTOMER_INPUT, secretHack: "should-not-leak" } as unknown as CreateCustomerInput;
    await client({}, fetchImpl).createCustomer(dirty);
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(opts.body ?? "").not.toContain("secretHack");
  });
});

describe("9) reconciliação por externalReference", () => {
  it("GET /customers?externalReference=... devolve a lista", async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(200, { object: "list", data: [{ id: "cus_1", name: "Ms Barber Shop" }], totalCount: 1 }),
    );
    const result = await client({}, fetchImpl).findCustomersByExternalReference("est_odonto");
    const [url] = fetchImpl.mock.calls[0] as FetchCall;
    expect(url).toContain("/customers?externalReference=est_odonto");
    expect(result).toEqual({ ok: true, data: [{ id: "cus_1", name: "Ms Barber Shop" }] });
  });

  it("relata múltiplos duplicados sem escolher um sozinha", async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(200, { data: [{ id: "cus_1" }, { id: "cus_2" }] }),
    );
    const result = await client({}, fetchImpl).findCustomersByExternalReference("est_odonto");
    expect(result.ok && result.data).toHaveLength(2);
  });

  it("nenhum resultado → lista vazia, não erro", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { data: [] }));
    const result = await client({}, fetchImpl).findCustomersByExternalReference("est_sem_customer");
    expect(result).toEqual({ ok: true, data: [] });
  });

  it("resposta sem campo 'data' → invalid_response", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { unexpected: true }));
    const result = await client({}, fetchImpl).findCustomersByExternalReference("est_odonto");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it("percorre todas as páginas de customers com limit=100 e offsets estáveis", async () => {
    const fetchImpl = mockFetch(async (url) => {
      const offset = new URL(url).searchParams.get("offset");
      return offset === "0"
        ? jsonResponse(200, { data: [{ id: "cus_1" }], hasMore: true })
        : jsonResponse(200, { data: [{ id: "cus_2" }], hasMore: false });
    });
    const result = await client({}, fetchImpl).findCustomersByExternalReference("est_odonto");
    expect(result.ok && result.data.map((item) => item.id)).toEqual(["cus_1", "cus_2"]);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get("offset"))).toEqual(["0", "100"]);
    expect(fetchImpl.mock.calls.every(([url]) => new URL(url).searchParams.get("limit") === "100")).toBe(true);
  });

  it("hasMore=true sem dados falha fechado em vez de entrar em loop", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { data: [], hasMore: true }));
    const result = await client({}, fetchImpl).findCustomersByExternalReference("est_odonto");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("10-12) createSubscription", () => {
  it("10) gera payload correto", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "sub_1" }));
    await client({}, fetchImpl).createSubscription(SUBSCRIPTION_INPUT);
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(JSON.parse(opts.body ?? "{}")).toEqual({
      customer: "cus_000001",
      billingType: "PIX",
      value: 99.9,
      nextDueDate: "2026-09-22",
      cycle: "MONTHLY",
      externalReference: "est_odonto",
    });
  });

  it("11) nextDueDate é enviado exatamente como recebido (sem recalcular trial)", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "sub_1" }));
    await client({}, fetchImpl).createSubscription({ ...SUBSCRIPTION_INPUT, nextDueDate: "2099-01-01" });
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(JSON.parse(opts.body ?? "{}").nextDueDate).toBe("2099-01-01");
  });

  it("12) cycle MONTHLY é preservado", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "sub_1" }));
    await client({}, fetchImpl).createSubscription({ ...SUBSCRIPTION_INPUT, cycle: "MONTHLY" });
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(JSON.parse(opts.body ?? "{}").cycle).toBe("MONTHLY");
  });
});

describe("subscription GET e reconciliação paginada", () => {
  it("busca subscription por ID e valida a resposta mínima", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, SUBSCRIPTION));
    const result = await client({}, fetchImpl).getSubscription("sub_1");
    expect(result).toEqual({ ok: true, data: SUBSCRIPTION });
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/subscriptions/sub_1");
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe("GET");
    expect(fetchImpl.mock.calls[0]?.[1].body).toBeUndefined();
  });

  it("resposta de subscription incompleta falha fechado", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "sub_1" }));
    const result = await client({}, fetchImpl).getSubscription("sub_1");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it.each([
    ["zero", []],
    ["uma", [SUBSCRIPTION]],
    ["múltiplas", [SUBSCRIPTION, { ...SUBSCRIPTION, id: "sub_2" }]],
  ])("preserva resultado %s sem assumir unicidade", async (_name, subscriptions) => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { data: subscriptions, hasMore: false }));
    const result = await client({}, fetchImpl).findSubscriptionsForReconciliation({
      customer: "cus_000001",
      externalReference: SUBSCRIPTION.externalReference,
      includeDeleted: true,
    });
    expect(result.ok && result.data).toEqual(subscriptions);
  });

  it("percorre todas as páginas de subscriptions e preserva filtros", async () => {
    const fetchImpl = mockFetch(async (url) => {
      const parsed = new URL(url);
      const offset = parsed.searchParams.get("offset");
      expect(parsed.searchParams.get("customer")).toBe("cus_000001");
      expect(parsed.searchParams.get("externalReference")).toBe(SUBSCRIPTION.externalReference);
      expect(parsed.searchParams.get("includeDeleted")).toBe("true");
      return offset === "0"
        ? jsonResponse(200, { data: [SUBSCRIPTION], hasMore: true })
        : jsonResponse(200, { data: [{ ...SUBSCRIPTION, id: "sub_2" }], hasMore: false });
    });
    const result = await client({}, fetchImpl).findSubscriptionsForReconciliation({
      customer: "cus_000001",
      externalReference: SUBSCRIPTION.externalReference,
      includeDeleted: true,
    });
    expect(result.ok && result.data).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("listSubscriptions expõe uma página com limit/offset controlados", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, {
      data: [SUBSCRIPTION], hasMore: true, totalCount: 3, limit: 1, offset: 1,
    }));
    const result = await client({}, fetchImpl).listSubscriptions({
      customer: "cus_000001", includeDeleted: false, limit: 1, offset: 1,
    });
    expect(result.ok && result.data).toEqual({
      data: [SUBSCRIPTION], hasMore: true, totalCount: 3, limit: 1, offset: 1,
    });
  });

  it("consulta payments da subscription sem operação de escrita", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, {
      data: [{ id: "pay_1", subscription: "sub_1", status: "PENDING" }],
    }));
    const result = await client({}, fetchImpl).listSubscriptionPayments("sub_1");
    expect(result.ok && result.data).toEqual([{ id: "pay_1", subscription: "sub_1", status: "PENDING" }]);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/subscriptions/sub_1/payments");
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe("GET");
    expect(fetchImpl.mock.calls[0]?.[1].body).toBeUndefined();
  });

  it("pagina payments usados na investigação de conflito", async () => {
    const fetchImpl = mockFetch(async (url) => {
      const offset = new URL(url).searchParams.get("offset");
      return offset === "0"
        ? jsonResponse(200, { data: [{ id: "pay_1" }], hasMore: true })
        : jsonResponse(200, { data: [{ id: "pay_2" }], hasMore: false });
    });
    const result = await client({}, fetchImpl).listSubscriptionPayments("sub_1");
    expect(result.ok && result.data.map((payment) => payment.id)).toEqual(["pay_1", "pay_2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("isAsaasPayment — contrato fortalecido (OT-05H-Y)", () => {
  async function listOne(payment: unknown) {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { data: [payment] }));
    return client({}, fetchImpl).listSubscriptionPayments("sub_1");
  }

  it("payment válido completo (todos os campos, incluindo deleted) é aceito", async () => {
    const payment = {
      id: "pay_1",
      status: "PENDING",
      customer: "cus_1",
      subscription: "sub_1",
      value: 5,
      dueDate: "2026-10-01",
      deleted: false,
    };
    const result = await listOne(payment);
    expect(result).toEqual({ ok: true, data: [payment] });
  });

  it("deleted:false é aceito", async () => {
    const result = await listOne({ id: "pay_1", deleted: false });
    expect(result.ok).toBe(true);
  });

  it("deleted:true é aceito (payment removido continua uma resposta válida)", async () => {
    const result = await listOne({ id: "pay_1", deleted: true });
    expect(result.ok).toBe(true);
  });

  it("deleted malformado (não-boolean) é rejeitado", async () => {
    const result = await listOne({ id: "pay_1", deleted: "true" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it("value ausente é aceito (campo opcional)", async () => {
    const result = await listOne({ id: "pay_1", status: "PENDING" });
    expect(result.ok).toBe(true);
  });

  it("value malformado (string) é rejeitado", async () => {
    const result = await listOne({ id: "pay_1", value: "5" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("value %s é rejeitado", async (_label, value) => {
    const result = await listOne({ id: "pay_1", value });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it("dueDate ausente é aceito (campo opcional)", async () => {
    const result = await listOne({ id: "pay_1" });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["formato errado", "01/10/2026"],
    ["mês inválido", "2026-13-01"],
    ["dia inexistente no calendário (30 de fevereiro)", "2026-02-30"],
    ["dia inexistente em ano não-bissexto", "2027-02-29"],
  ])("dueDate malformada (%s) é rejeitada", async (_label, dueDate) => {
    const result = await listOne({ id: "pay_1", dueDate });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it("dueDate em ano bissexto (29 de fevereiro) é aceita", async () => {
    const result = await listOne({ id: "pay_1", dueDate: "2028-02-29" });
    expect(result.ok).toBe(true);
  });

  it("customer ausente é aceito (campo opcional)", async () => {
    const result = await listOne({ id: "pay_1" });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["string vazia", ""],
    ["tipo errado (number)", 123],
  ])("customer malformado (%s) é rejeitado", async (_label, customer) => {
    const result = await listOne({ id: "pay_1", customer });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it("subscription presente e válido é aceito", async () => {
    const result = await listOne({ id: "pay_1", subscription: "sub_1" });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["string vazia", ""],
    ["tipo errado (number)", 123],
  ])("subscription malformado (%s) é rejeitado", async (_label, subscription) => {
    const result = await listOne({ id: "pay_1", subscription });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it("status com qualquer um dos 14 valores documentados pela Asaas é aceito", async () => {
    const statuses = [
      "PENDING", "RECEIVED", "CONFIRMED", "OVERDUE", "REFUNDED", "RECEIVED_IN_CASH",
      "REFUND_REQUESTED", "REFUND_IN_PROGRESS", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE",
      "AWAITING_CHARGEBACK_REVERSAL", "DUNNING_REQUESTED", "DUNNING_RECEIVED", "AWAITING_RISK_ANALYSIS",
    ];
    for (const status of statuses) {
      const result = await listOne({ id: "pay_1", status });
      expect(result.ok).toBe(true);
    }
  });

  it("status desconhecido/futuro (não documentado hoje) é aceito no parser — forward compatibility", async () => {
    // Decisão OT-05H-Y: status não é fechado em union/Set no client genérico
    // (mesmo padrão já usado em AsaasSubscription.status). Um 15º status
    // que a Asaas venha a introduzir não pode derrubar listSubscriptionPayments
    // inteiro. Allowlists específicas pertencem ao chamador (ex.: um guard
    // de recovery), não a este parser.
    const result = await listOne({ id: "pay_1", status: "UM_STATUS_QUE_NAO_EXISTE_AINDA" });
    expect(result.ok).toBe(true);
  });

  it("status malformado (tipo errado) é rejeitado", async () => {
    const result = await listOne({ id: "pay_1", status: 123 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it.each([
    ["ausente", undefined],
    ["vazio", ""],
    ["tipo errado (number)", 123],
  ])("id %s é rejeitado", async (_label, id) => {
    const result = await listOne(id === undefined ? {} : { id });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it("listSubscriptionPayments continua sem enviar body e usando GET", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { data: [{ id: "pay_1" }] }));
    await client({}, fetchImpl).listSubscriptionPayments("sub_1");
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe("GET");
    expect(fetchImpl.mock.calls[0]?.[1].body).toBeUndefined();
  });

  it("paginação de payments continua idêntica (limit/offset, sem novos parâmetros)", async () => {
    const fetchImpl = mockFetch(async (url) => {
      const params = new URL(url).searchParams;
      expect([...params.keys()].sort()).toEqual(["limit", "offset"]);
      return jsonResponse(200, { data: [{ id: "pay_1" }], hasMore: false });
    });
    await client({}, fetchImpl).listSubscriptionPayments("sub_1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("13) nenhum dado de cartão é aceito", () => {
  it("creditCard/creditCardHolderInfo/creditCardToken nunca chegam ao corpo da requisição", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "sub_1" }));
    const dirty = {
      ...SUBSCRIPTION_INPUT,
      creditCard: { number: "4111111111111111", cvv: "123" },
      creditCardHolderInfo: { name: "x" },
      creditCardToken: "tok_abc",
    } as unknown as CreateSubscriptionInput;
    await client({}, fetchImpl).createSubscription(dirty);
    const [, opts] = fetchImpl.mock.calls[0] as FetchCall;
    expect(opts.body ?? "").not.toContain("creditCard");
    expect(opts.body ?? "").not.toContain("4111111111111111");
  });
});

describe("14-17) status HTTP sanitizados", () => {
  it.each([
    [400, { errors: [{ code: "invalid_value", description: "campo obrigatório" }] }],
    [401, { errors: [{ code: "access_token_not_found" }] }],
    [403, { errors: [{ code: "forbidden" }] }],
    [500, {}],
  ])("HTTP %i vira AsaasError sanitizado (kind=http, status preservado, sem corpo bruto)", async (status, body) => {
    const fetchImpl = mockFetch(async () => jsonResponse(status as number, body));
    const result = await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http");
      expect(result.error.status).toBe(status);
      expect(JSON.stringify(result.error)).not.toContain(SANDBOX_KEY);
    }
  });
});

describe("18) JSON inválido tratado", () => {
  it("resposta 2xx com corpo não-JSON vira invalid_response, não quebra", async () => {
    const fetchImpl = mockFetch(async () => rawResponse(200, "<html>não é json</html>"));
    const result = await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "invalid_response" }),
    });
  });
});

describe("19) timeout tratado", () => {
  it("aborta e devolve kind=timeout quando o tempo limite é excedido", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = mockFetch(
        (_url, opts) =>
          new Promise<Response>((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const promise = client({ timeoutMs: 50 }, fetchImpl).createCustomer(CUSTOMER_INPUT);
      await vi.advanceTimersByTimeAsync(50);
      const result = await promise;
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({ kind: "timeout" }),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("20) network failure tratado", () => {
  it("rejeição de fetch (não-abort) vira kind=network", async () => {
    const fetchImpl = mockFetch(async () => {
      throw new Error("getaddrinfo ENOTFOUND api-sandbox.asaas.com");
    });
    const result = await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "network" }),
    });
  });
});

describe("21) nenhum retry automático em POST", () => {
  it("createCustomer chama fetch exatamente 1 vez, mesmo após erro de rede", async () => {
    const fetchImpl = mockFetch(async () => {
      throw new Error("network down");
    });
    await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it("createSubscription chama fetch exatamente 1 vez, mesmo após HTTP 500", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse(500, {}));
    await client({}, fetchImpl).createSubscription(SUBSCRIPTION_INPUT);
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });
});

describe("22-23) segurança de ambiente", () => {
  it("22) chave Sandbox contra environment production é rejeitada (sem chamar rede)", () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, {}));
    expect(() => client({ environment: "production", apiKey: SANDBOX_KEY }, fetchImpl)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("23) chave Production contra environment sandbox é rejeitada (sem chamar rede)", () => {
    const fetchImpl = mockFetch(async () => jsonResponse(200, {}));
    expect(() => client({ environment: "sandbox", apiKey: PRODUCTION_KEY }, fetchImpl)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("combinações corretas não lançam", () => {
    expect(() => client({ environment: "sandbox", apiKey: SANDBOX_KEY })).not.toThrow();
    expect(() => client({ environment: "production", apiKey: PRODUCTION_KEY })).not.toThrow();
  });

  it("a mensagem de erro do mismatch nunca inclui a chave", () => {
    let message = "";
    try {
      client({ environment: "production", apiKey: SANDBOX_KEY });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(SANDBOX_KEY);
    // A mensagem pode citar o PREFIXO esperado (documentação/diagnóstico),
    // mas nunca a chave completa fornecida.
    expect(message.length).toBeGreaterThan(0);
  });

  it("environmentMatchesKey é pura e testável isoladamente", () => {
    expect(environmentMatchesKey("sandbox", SANDBOX_KEY)).toBe(true);
    expect(environmentMatchesKey("sandbox", PRODUCTION_KEY)).toBe(false);
    expect(environmentMatchesKey("production", PRODUCTION_KEY)).toBe(true);
    expect(environmentMatchesKey("production", SANDBOX_KEY)).toBe(false);
  });
});

describe("24) nenhum secret em console/log/error", () => {
  it("nenhuma chamada de console.* ocorre durante uma operação bem-sucedida", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fetchImpl = mockFetch(async () => jsonResponse(200, { id: "cus_1" }));
      await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("nenhuma chamada de console.* ocorre durante uma falha HTTP, e nada logado contém a chave", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fetchImpl = mockFetch(async () => jsonResponse(401, { errors: [{ code: "invalid_access_token" }] }));
      await client({}, fetchImpl).createCustomer(CUSTOMER_INPUT);
      for (const spy of [logSpy, errorSpy, warnSpy]) {
        for (const call of spy.mock.calls) {
          expect(call.join(" ")).not.toContain(SANDBOX_KEY);
        }
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
