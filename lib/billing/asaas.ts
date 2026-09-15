// Cliente HTTP isolado para a API do Asaas (OT-05C — fundação de
// comunicação, sem integração ao fluxo real da Lívia). Nenhuma rota chama
// este módulo ainda; nenhuma credencial real está configurada em nenhum
// ambiente.
//
// Contrato confirmado na documentação oficial (docs.asaas.com) em
// 2026-09 — nada aqui foi assumido de memória:
//   - Autenticação: header `access_token: <API_KEY>` — a Asaas
//     explicitamente NÃO usa `Authorization: Bearer`.
//   - Base URLs: sandbox https://api-sandbox.asaas.com/v3,
//     production https://api.asaas.com/v3.
//   - Prefixos de chave: sandbox `$aact_hmlg_`, production `$aact_prod_`
//     (a própria Asaas também rejeita no servidor uma chave do ambiente
//     errado, com o código de erro `invalid_environment` — nossa checagem
//     de prefixo é defesa em profundidade ANTES de gastar uma chamada de
//     rede, não uma duplicação do que o servidor já faz).
//   - Erros: corpo `{ errors: [{ code, description }] }` em qualquer
//     status não-2xx.
//   - `POST /customers` permite clientes duplicados (documentado
//     explicitamente) — por isso este módulo nunca faz retry cego dessa
//     chamada; oferece uma função de reconciliação por `externalReference`
//     em vez disso.
//   - `POST /subscriptions`: campos mínimos confirmados
//     (customer, billingType, value, nextDueDate, cycle); billingType em
//     {UNDEFINED, BOLETO, CREDIT_CARD, PIX}; cycle inclui MONTHLY entre
//     outros. Nenhum campo de cartão (creditCard/creditCardHolderInfo/
//     creditCardToken) existe no tipo de entrada desta função — a Lívia
//     não manipula dado de cartão nesta fase.

// ---- Ambiente ----

export type AsaasEnvironment = "sandbox" | "production";

const BASE_URLS: Record<AsaasEnvironment, string> = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
};

// Prefixos oficiais atuais das chaves de API — usados SÓ para validação de
// ambiente antes de qualquer chamada de rede. Nunca logados nem incluídos
// em nenhuma mensagem de erro devolvida ao chamador.
const KEY_PREFIXES: Record<AsaasEnvironment, string> = {
  sandbox: "$aact_hmlg_",
  production: "$aact_prod_",
};

// Pura e exportada separadamente para ser testável sem precisar construir um
// client inteiro. Nunca inclui a própria chave no retorno — só um booleano.
export function environmentMatchesKey(environment: AsaasEnvironment, apiKey: string): boolean {
  return apiKey.startsWith(KEY_PREFIXES[environment]);
}

// ---- Erros ----

export type AsaasErrorKind = "http" | "timeout" | "network" | "invalid_response";

export interface AsaasApiErrorDetail {
  code?: string;
  description?: string;
}

// Nunca carrega a chave, headers, ou o request/response bruto — só o status
// HTTP (quando existir) e os `errors[]` já sanitizados pelo parsing abaixo.
export interface AsaasError {
  kind: AsaasErrorKind;
  status?: number;
  errors?: AsaasApiErrorDetail[];
  message: string;
}

export type AsaasResult<T> = { ok: true; data: T } | { ok: false; error: AsaasError };

// ---- Configuração do client ----

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "Livia (billing-client)";

export interface AsaasClientConfig {
  environment: AsaasEnvironment;
  apiKey: string;
  // Injeção explícita — nunca lido de process.env dentro das operações.
  // Quem monta a config decide de onde vem a chave (env, secret manager,
  // etc.); este módulo só recebe o valor já resolvido.
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  userAgent: string;
}

// Configuração inválida (ambiente/chave incompatíveis) é um erro de
// PROGRAMAÇÃO/implantação — falha rápido e alto (throw), diferente dos
// erros de runtime por operação (rede/timeout/HTTP), que usam AsaasResult.
// Mesmo padrão de loadAppCredentials() em lib/whatsapp/embedded.ts. A
// mensagem lançada nunca inclui a chave, mesmo parcialmente.
export function createAsaasClient(config: AsaasClientConfig): AsaasClient {
  if (!environmentMatchesKey(config.environment, config.apiKey)) {
    throw new Error(
      `Asaas: a chave de API informada não corresponde ao ambiente "${config.environment}" ` +
        `(prefixo esperado "${KEY_PREFIXES[config.environment]}"). Nunca use uma chave de ` +
        `sandbox contra production, nem o inverso.`,
    );
  }

  const resolved: ResolvedConfig = {
    baseUrl: BASE_URLS[config.environment],
    apiKey: config.apiKey,
    fetchImpl: config.fetchImpl ?? fetch,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
  };

  return {
    createCustomer: (input) => createCustomer(resolved, input),
    findCustomersByExternalReference: (externalReference) =>
      findCustomersByExternalReference(resolved, externalReference),
    createSubscription: (input) => createSubscription(resolved, input),
  };
}

export interface AsaasClient {
  createCustomer(input: CreateCustomerInput): Promise<AsaasResult<AsaasCustomer>>;
  findCustomersByExternalReference(externalReference: string): Promise<AsaasResult<AsaasCustomer[]>>;
  createSubscription(input: CreateSubscriptionInput): Promise<AsaasResult<AsaasSubscription>>;
}

// ---- Wrapper HTTP central ----
//
// Responsabilidades únicas deste helper: montar a URL/headers corretos,
// aplicar timeout via AbortController, fazer o parsing seguro da resposta,
// e classificar qualquer falha num AsaasError sanitizado. Nunca decide
// retry — cada operação (createCustomer, createSubscription, ...) decide
// isso sozinha, e esta OT define explicitamente: NENHUM retry automático em
// POST (ver createCustomer/createSubscription abaixo).
async function request<T>(
  config: ResolvedConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<AsaasResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await config.fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        access_token: config.apiKey,
        "Content-Type": "application/json",
        "User-Agent": config.userAgent,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: isAbort
        ? { kind: "timeout", message: `Asaas: tempo limite (${config.timeoutMs}ms) excedido.` }
        : { kind: "network", message: "Asaas: falha de rede ao contactar a API." },
    };
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    // Corpo de erro documentado: { errors: [{ code, description }] }. Se o
    // corpo não bater com esse formato (ex.: página de erro de um proxy),
    // degrada para status sem detalhe — NUNCA inclui o texto bruto do
    // corpo, que poderia carregar HTML/infra alheia à Asaas.
    const errors = extractErrorList(parsed);
    return {
      ok: false,
      error: {
        kind: "http",
        status: response.status,
        ...(errors ? { errors } : {}),
        message: `Asaas: requisição falhou (HTTP ${response.status}).`,
      },
    };
  }

  if (parsed === undefined) {
    return {
      ok: false,
      error: { kind: "invalid_response", status: response.status, message: "Asaas: resposta não é JSON válido." },
    };
  }

  return { ok: true, data: parsed as T };
}

function extractErrorList(parsed: unknown): AsaasApiErrorDetail[] | undefined {
  if (!parsed || typeof parsed !== "object" || !("errors" in parsed)) return undefined;
  const errors = (parsed as { errors: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  return errors
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      code: typeof e.code === "string" ? e.code : undefined,
      description: typeof e.description === "string" ? e.description : undefined,
    }));
}

// ---- Customers ----

export interface CreateCustomerInput {
  name: string;
  cpfCnpj: string;
  email?: string;
  phone?: string;
  mobilePhone?: string;
  // Convenção desta integração: externalReference = establishmentId (ver
  // OT-05A, seção ASAAS CUSTOMER). Nunca inferido aqui — sempre o que o
  // chamador passar.
  externalReference?: string;
  notificationDisabled?: boolean;
}

export interface AsaasCustomer {
  id: string;
  name: string;
  cpfCnpj?: string;
  email?: string;
  externalReference?: string;
  dateCreated?: string;
}

// Sem retry automático de propósito: a Asaas permite clientes duplicados
// (documentado), então repetir esta chamada às cegas após um
// timeout/resultado inconclusivo criaria clientes duplicados
// silenciosamente. Em caso de timeout/erro de rede, o chamador deve usar
// findCustomersByExternalReference() para reconciliar ANTES de tentar de
// novo — esta função nunca decide isso sozinha.
async function createCustomer(
  config: ResolvedConfig,
  input: CreateCustomerInput,
): Promise<AsaasResult<AsaasCustomer>> {
  // Corpo construído campo a campo (nunca `...input` bruto) — garante que
  // só os campos explicitamente permitidos por este tipo chegam à Asaas,
  // mesmo que o chamador (ou um erro de tipagem em runtime) tenha
  // acrescentado propriedades extras ao objeto de entrada.
  const body = {
    name: input.name,
    cpfCnpj: input.cpfCnpj,
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.mobilePhone !== undefined ? { mobilePhone: input.mobilePhone } : {}),
    ...(input.externalReference !== undefined ? { externalReference: input.externalReference } : {}),
    ...(input.notificationDisabled !== undefined ? { notificationDisabled: input.notificationDisabled } : {}),
  };
  return request<AsaasCustomer>(config, "POST", "/customers", body);
}

// Reconciliação por externalReference (GET /customers?externalReference=...)
// — usada ANTES de repetir um createCustomer após timeout/erro inconclusivo,
// e para localizar um customer já criado num provisionamento anterior.
// Devolve a lista inteira: como a Asaas permite duplicados, decidir o que
// fazer com mais de um resultado é responsabilidade do chamador (esta
// função só relata o que existe, nunca escolhe um "vencedor" sozinha).
async function findCustomersByExternalReference(
  config: ResolvedConfig,
  externalReference: string,
): Promise<AsaasResult<AsaasCustomer[]>> {
  const query = new URLSearchParams({ externalReference }).toString();
  const result = await request<{ data?: unknown }>(config, "GET", `/customers?${query}`);
  if (!result.ok) return result;

  const data = result.data.data;
  if (!Array.isArray(data)) {
    return {
      ok: false,
      error: { kind: "invalid_response", message: "Asaas: resposta de listagem de clientes sem campo 'data'." },
    };
  }
  return { ok: true, data: data as AsaasCustomer[] };
}

// ---- Subscriptions ----

export type AsaasBillingType = "UNDEFINED" | "BOLETO" | "CREDIT_CARD" | "PIX";

export type AsaasCycle =
  | "WEEKLY"
  | "BIWEEKLY"
  | "MONTHLY"
  | "BIMONTHLY"
  | "QUARTERLY"
  | "SEMIANNUALLY"
  | "YEARLY";

// Deliberadamente SEM creditCard/creditCardHolderInfo/creditCardToken — a
// Lívia não manipula PAN/CVV nesta fase (OT-05C). `nextDueDate` é
// repassado EXATAMENTE como recebido: este módulo não sabe que existe um
// trial de 7 dias, nem calcula nenhuma data — isso é responsabilidade da
// camada de billing/provisionamento (ver OT-05A/OT-05B). `value`/`cycle`
// idem: o chamador decide o plano, este módulo só transmite.
export interface CreateSubscriptionInput {
  customer: string; // id do customer no Asaas (resultado de createCustomer)
  billingType: AsaasBillingType;
  value: number;
  nextDueDate: string; // "YYYY-MM-DD", já pronto — nunca recalculado aqui
  cycle: AsaasCycle;
  description?: string;
  externalReference?: string;
}

// IMPORTANTE (documentar no chamador, não só aqui): um AsaasResult ok:true
// aqui significa SOMENTE "a assinatura foi criada no Asaas" — nunca
// "o pagamento foi confirmado". A confirmação de pagamento chega depois,
// por um evento de cobrança/webhook (fora de escopo desta OT). subStatus
// no tipo de retorno é o espelho BRUTO do Asaas, só para diagnóstico —
// nunca a fonte de verdade de acesso (essa é BillingStatus, calculada pela
// máquina de estados em lib/billing/stateMachine.ts, que não lê este
// campo).
export interface AsaasSubscription {
  id: string;
  customer: string;
  billingType: AsaasBillingType;
  value: number;
  nextDueDate: string;
  cycle: AsaasCycle;
  externalReference?: string;
  // Status bruto devolvido pela Asaas (ex.: "ACTIVE") — nunca confundir com
  // BillingStatus (types/index.ts), que é o estado canônico interno.
  status?: string;
}

// Sem retry automático nesta função também — mesmo raciocínio de
// createCustomer: um timeout não prova que a assinatura não foi criada, e
// tentar de novo às cegas arrisca duas assinaturas para o mesmo cliente.
async function createSubscription(
  config: ResolvedConfig,
  input: CreateSubscriptionInput,
): Promise<AsaasResult<AsaasSubscription>> {
  const body = {
    customer: input.customer,
    billingType: input.billingType,
    value: input.value,
    nextDueDate: input.nextDueDate,
    cycle: input.cycle,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.externalReference !== undefined ? { externalReference: input.externalReference } : {}),
  };
  return request<AsaasSubscription>(config, "POST", "/subscriptions", body);
}
