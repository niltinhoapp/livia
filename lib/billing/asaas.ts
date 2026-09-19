// Cliente HTTP isolado para a API do Asaas (OT-05C — fundação de
// comunicação, sem integração ao fluxo real da Lívia). Seu único chamador
// HTTP é o harness administrativo de homologação, restrito ao Preview e ao
// Sandbox; nenhuma rota de produto ou ambiente Production usa credenciais.
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
    checkAuthentication: () => checkAuthentication(resolved),
    createCustomer: (input) => createCustomer(resolved, input),
    findCustomersByExternalReference: (externalReference) =>
      findCustomersByExternalReference(resolved, externalReference),
    createSubscription: (input) => createSubscription(resolved, input),
    getSubscription: (id) => getSubscription(resolved, id),
    listSubscriptions: (input) => listSubscriptions(resolved, input),
    findSubscriptionsForReconciliation: (input) =>
      findSubscriptionsForReconciliation(resolved, input),
    listSubscriptionPayments: (subscriptionId) =>
      listSubscriptionPayments(resolved, subscriptionId),
    getPixQrCode: (paymentId) => getPixQrCode(resolved, paymentId),
    createCheckout: (input) => createCheckout(resolved, input),
  };
}

export interface AsaasClient {
  checkAuthentication(): Promise<AsaasResult<{ authenticated: true }>>;
  createCustomer(input: CreateCustomerInput): Promise<AsaasResult<AsaasCustomer>>;
  findCustomersByExternalReference(externalReference: string): Promise<AsaasResult<AsaasCustomer[]>>;
  createSubscription(input: CreateSubscriptionInput): Promise<AsaasResult<AsaasSubscription>>;
  getSubscription(id: string): Promise<AsaasResult<AsaasSubscription>>;
  listSubscriptions(input: ListSubscriptionsInput): Promise<AsaasResult<AsaasListPage<AsaasSubscription>>>;
  findSubscriptionsForReconciliation(
    input: FindSubscriptionsInput,
  ): Promise<AsaasResult<AsaasSubscription[]>>;
  listSubscriptionPayments(subscriptionId: string): Promise<AsaasResult<AsaasPayment[]>>;
  // GET /payments/{id}/pixQrCode (OT-07E2) — leitura pura, nunca cria
  // cobrança. É o passo de integração PIX documentado oficialmente
  // (docs.asaas.com/reference/get-qr-code-for-pix-payments): "crie a
  // cobrança, depois envie o ID retornado para recuperar os dados do QR
  // Code". Preferido a invoiceUrl (que também existe, documentado em
  // docs.asaas.com/reference/criar-nova-cobranca) porque mantém o cliente
  // dentro do painel da Lívia em vez de redirecioná-lo para asaas.com, e
  // porque é o caminho que a própria documentação de PIX descreve.
  getPixQrCode(paymentId: string): Promise<AsaasResult<AsaasPixQrCode>>;
  // POST /v3/checkouts — usado só pelo harness de homologação Sandbox nesta
  // fase (ver comentário acima de createCheckout).
  createCheckout(input: CreateCheckoutInput): Promise<AsaasResult<AsaasCheckout>>;
}

// Leitura mínima para homologar credencial/conectividade sem criar qualquer
// recurso. O número da conta devolvido pela Asaas é deliberadamente
// descartado: o harness só precisa saber que a credencial foi autenticada.
async function checkAuthentication(
  config: ResolvedConfig,
): Promise<AsaasResult<{ authenticated: true }>> {
  const result = await request<unknown>(config, "GET", "/myAccount/accountNumber");
  if (!result.ok) return result;
  if (!result.data || typeof result.data !== "object") {
    return invalidResponse("Asaas: resposta de autenticação inválida.");
  }
  return { ok: true, data: { authenticated: true } };
}

export interface AsaasListPage<T> {
  data: T[];
  hasMore: boolean;
  totalCount?: number;
  limit: number;
  offset: number;
}

const LIST_PAGE_SIZE = 100;
// Defesa contra resposta malformada que mantenha hasMore=true indefinidamente.
// Não é limite funcional da Asaas; é um teto local de segurança por operação.
const MAX_LIST_PAGES = 1_000;

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
  return collectAllPages<AsaasCustomer>(config, "/customers", { externalReference }, "clientes");
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
  description?: string;
  externalReference?: string;
  // Status bruto devolvido pela Asaas (ex.: "ACTIVE") — nunca confundir com
  // BillingStatus (types/index.ts), que é o estado canônico interno.
  status?: string;
}

export interface ListSubscriptionsInput {
  customer?: string;
  externalReference?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export type FindSubscriptionsInput = Omit<ListSubscriptionsInput, "limit" | "offset">;

// `status` é mantido como string livre (não um union fechado), pelo mesmo
// motivo de `AsaasSubscription.status`: é um valor que só a Asaas produz e
// pode evoluir (a documentação oficial já lista 14 valores hoje — ver
// OT-05H-X). Fechar isso num Set faria isAsaasPayment rejeitar toda
// resposta assim que a Asaas introduzir um 15º status, derrubando
// listSubscriptionPayments inteiro por forward-incompatibilidade. Qualquer
// allowlist específica (ex.: quais status contam como "cobrança realmente
// emitida" para um guard de recovery) pertence ao chamador, não ao parser
// genérico do client. `deleted` reflete o campo documentado da Asaas
// ("determina se a cobrança foi removida") — ver OT-05H-X.
export interface AsaasPayment {
  id: string;
  status?: string;
  customer?: string;
  subscription?: string;
  value?: number;
  dueDate?: string;
  deleted?: boolean;
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

async function getSubscription(
  config: ResolvedConfig,
  id: string,
): Promise<AsaasResult<AsaasSubscription>> {
  const result = await request<unknown>(
    config,
    "GET",
    `/subscriptions/${encodeURIComponent(id)}`,
  );
  if (!result.ok) return result;
  if (!isAsaasSubscription(result.data)) {
    return invalidResponse("Asaas: resposta de assinatura sem os campos mínimos esperados.");
  }
  return { ok: true, data: result.data };
}

// ---- Checkout hospedado (docs.asaas.com/reference/create-new-checkout,
// confirmado em 2026-09) ----
//
// POST /v3/checkouts. Usado SÓ pelo harness de homologação Sandbox nesta
// fase (OT de verificação empírica do Hosted Checkout) — nenhuma rota de
// produto chama isto ainda. billingTypes/chargeTypes documentados: o
// exemplo oficial de "Checkout com Assinatura (recorrente)" só mostra
// CREDIT_CARD; a página dedicada de PIX ("Checkout para Pix") cobre
// exclusivamente DETACHED e remete a assinatura pra doc de cartão — não há
// confirmação oficial de PIX combinado com chargeTypes=RECURRENT (ver
// auditoria da OT). Este módulo aceita ambos os valores no tipo porque a
// Asaas os aceita para DETACHED; a decisão de QUAIS combinar em cada
// chargeType é do chamador, nunca deste client.
export type AsaasCheckoutBillingType = "PIX" | "CREDIT_CARD";
export type AsaasCheckoutChargeType = "DETACHED" | "RECURRENT" | "INSTALLMENT";
// Únicos 4 valores documentados (docs.asaas.com/docs/asaas-checkout).
export type AsaasCheckoutStatus = "ACTIVE" | "CANCELED" | "EXPIRED" | "PAID";

export interface CreateCheckoutItemInput {
  name: string;
  quantity: number;
  value: number;
  description?: string;
}

// Só os 3 campos documentados no schema CheckoutSessionSubscriptionDTO —
// sem externalReference próprio (não existe no schema oficial; ver
// auditoria da OT sobre onde o externalReference realmente aparece).
export interface CreateCheckoutSubscriptionInput {
  cycle: AsaasCycle;
  nextDueDate: string;
  endDate?: string;
}

export interface CreateCheckoutCallbackInput {
  successUrl: string;
  cancelUrl: string;
  expiredUrl?: string;
}

export interface CreateCheckoutInput {
  billingTypes: AsaasCheckoutBillingType[];
  chargeTypes: AsaasCheckoutChargeType[];
  callback: CreateCheckoutCallbackInput;
  items: CreateCheckoutItemInput[];
  externalReference?: string;
  minutesToExpire?: number;
  subscription?: CreateCheckoutSubscriptionInput;
}

// IMPORTANTE (mesmo espírito do comentário em AsaasSubscription): ok:true
// aqui significa SOMENTE "o Checkout foi criado", nunca "o pagamento foi
// confirmado" — a doc oficial é explícita: "creating the checkout returns
// a payment page, not a financial confirmation". `status` é o espelho
// BRUTO do Asaas — nunca a fonte de verdade de billingStatus.
export interface AsaasCheckout {
  id: string;
  link: string;
  status: AsaasCheckoutStatus;
  externalReference?: string;
}

async function createCheckout(
  config: ResolvedConfig,
  input: CreateCheckoutInput,
): Promise<AsaasResult<AsaasCheckout>> {
  const body = {
    billingTypes: input.billingTypes,
    chargeTypes: input.chargeTypes,
    callback: {
      successUrl: input.callback.successUrl,
      cancelUrl: input.callback.cancelUrl,
      ...(input.callback.expiredUrl !== undefined ? { expiredUrl: input.callback.expiredUrl } : {}),
    },
    items: input.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      value: item.value,
      ...(item.description !== undefined ? { description: item.description } : {}),
    })),
    ...(input.externalReference !== undefined ? { externalReference: input.externalReference } : {}),
    ...(input.minutesToExpire !== undefined ? { minutesToExpire: input.minutesToExpire } : {}),
    ...(input.subscription !== undefined
      ? {
          subscription: {
            cycle: input.subscription.cycle,
            nextDueDate: input.subscription.nextDueDate,
            ...(input.subscription.endDate !== undefined ? { endDate: input.subscription.endDate } : {}),
          },
        }
      : {}),
  };
  const result = await request<unknown>(config, "POST", "/checkouts", body);
  if (!result.ok) return result;
  if (!isAsaasCheckout(result.data)) {
    return invalidResponse("Asaas: resposta de checkout sem os campos mínimos esperados.");
  }
  return { ok: true, data: result.data };
}
// Deliberadamente SEM getCheckout: a auditoria da OT não confirmou a
// existência de um GET /v3/checkouts/{id} na documentação oficial — não
// adiciona ao client um endpoint que não foi verificado. Se for confirmado
// necessário, adicionar com a mesma disciplina do resto deste arquivo.

async function listSubscriptions(
  config: ResolvedConfig,
  input: ListSubscriptionsInput,
): Promise<AsaasResult<AsaasListPage<AsaasSubscription>>> {
  const limit = input.limit ?? LIST_PAGE_SIZE;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_PAGE_SIZE || !Number.isInteger(offset) || offset < 0) {
    return invalidResponse("Asaas: paginação de assinaturas inválida.");
  }

  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (input.customer !== undefined) query.set("customer", input.customer);
  if (input.externalReference !== undefined) query.set("externalReference", input.externalReference);
  if (input.includeDeleted !== undefined) query.set("includeDeleted", String(input.includeDeleted));

  const result = await request<unknown>(config, "GET", `/subscriptions?${query.toString()}`);
  if (!result.ok) return result;
  return parseListPage(result.data, limit, offset, "assinaturas", isAsaasSubscription);
}

async function findSubscriptionsForReconciliation(
  config: ResolvedConfig,
  input: FindSubscriptionsInput,
): Promise<AsaasResult<AsaasSubscription[]>> {
  return collectAllPages<AsaasSubscription>(
    config,
    "/subscriptions",
    {
      ...(input.customer !== undefined ? { customer: input.customer } : {}),
      ...(input.externalReference !== undefined ? { externalReference: input.externalReference } : {}),
      ...(input.includeDeleted !== undefined ? { includeDeleted: String(input.includeDeleted) } : {}),
    },
    "assinaturas",
    isAsaasSubscription,
  );
}

async function listSubscriptionPayments(
  config: ResolvedConfig,
  subscriptionId: string,
): Promise<AsaasResult<AsaasPayment[]>> {
  return collectAllPages<AsaasPayment>(
    config,
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`,
    {},
    "cobranças",
    isAsaasPayment,
  );
}

// Dados para o cliente final concluir um pagamento PIX (OT-07E2) — nunca
// inclui dado de outra cobrança/subscription: o escopo é sempre o
// paymentId explícito recebido, resolvido server-side (ver
// lib/billing/pixPayment.ts).
export interface AsaasPixQrCode {
  encodedImage: string; // imagem do QR Code em base64 (PNG)
  payload: string; // código "copia e cola"
  expirationDate?: string;
}

async function getPixQrCode(
  config: ResolvedConfig,
  paymentId: string,
): Promise<AsaasResult<AsaasPixQrCode>> {
  const result = await request<unknown>(
    config,
    "GET",
    `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
  );
  if (!result.ok) return result;
  if (!isAsaasPixQrCode(result.data)) {
    return invalidResponse("Asaas: resposta de QR Code Pix sem os campos mínimos esperados.");
  }
  return { ok: true, data: result.data };
}

function isAsaasPixQrCode(value: unknown): value is AsaasPixQrCode {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.encodedImage !== "string" || item.encodedImage.length === 0) return false;
  if (typeof item.payload !== "string" || item.payload.length === 0) return false;
  if (item.expirationDate !== undefined && typeof item.expirationDate !== "string") return false;
  return true;
}

function invalidResponse<T>(message: string): AsaasResult<T> {
  return { ok: false, error: { kind: "invalid_response", message } };
}

function parseListPage<T>(
  payload: unknown,
  requestedLimit: number,
  requestedOffset: number,
  resourceName: string,
  validateItem?: (item: unknown) => item is T,
  requirePagination = true,
): AsaasResult<AsaasListPage<T>> {
  if (!payload || typeof payload !== "object") {
    return invalidResponse(`Asaas: resposta de listagem de ${resourceName} inválida.`);
  }
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.data) || (validateItem && !raw.data.every(validateItem))) {
    return invalidResponse(`Asaas: resposta de listagem de ${resourceName} sem campo 'data' válido.`);
  }
  if (raw.hasMore !== undefined && typeof raw.hasMore !== "boolean") {
    return invalidResponse(`Asaas: paginação de ${resourceName} com 'hasMore' inválido.`);
  }
  if (requirePagination && raw.hasMore === true && raw.data.length === 0) {
    return invalidResponse(`Asaas: paginação de ${resourceName} não avançou.`);
  }
  return {
    ok: true,
    data: {
      data: raw.data as T[],
      hasMore: raw.hasMore === true,
      totalCount: typeof raw.totalCount === "number" ? raw.totalCount : undefined,
      limit: typeof raw.limit === "number" ? raw.limit : requestedLimit,
      offset: typeof raw.offset === "number" ? raw.offset : requestedOffset,
    },
  };
}

async function collectAllPages<T>(
  config: ResolvedConfig,
  path: string,
  filters: Record<string, string>,
  resourceName: string,
  validateItem?: (item: unknown) => item is T,
): Promise<AsaasResult<T[]>> {
  const all: T[] = [];
  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    const offset = pageNumber * LIST_PAGE_SIZE;
    const query = new URLSearchParams({ ...filters, limit: String(LIST_PAGE_SIZE), offset: String(offset) });
    const result = await request<unknown>(config, "GET", `${path}?${query.toString()}`);
    if (!result.ok) return result;
    const page = parseListPage(result.data, LIST_PAGE_SIZE, offset, resourceName, validateItem);
    if (!page.ok) return page;
    all.push(...page.data.data);
    if (!page.data.hasMore) return { ok: true, data: all };
  }
  return invalidResponse(`Asaas: paginação de ${resourceName} excedeu o limite de segurança.`);
}

const BILLING_TYPES = new Set<AsaasBillingType>(["UNDEFINED", "BOLETO", "CREDIT_CARD", "PIX"]);
const CYCLES = new Set<AsaasCycle>([
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "BIMONTHLY",
  "QUARTERLY",
  "SEMIANNUALLY",
  "YEARLY",
]);

function isAsaasSubscription(value: unknown): value is AsaasSubscription {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" && item.id.length > 0 &&
    typeof item.customer === "string" && item.customer.length > 0 &&
    typeof item.billingType === "string" && BILLING_TYPES.has(item.billingType as AsaasBillingType) &&
    typeof item.value === "number" && Number.isFinite(item.value) &&
    typeof item.nextDueDate === "string" &&
    typeof item.cycle === "string" && CYCLES.has(item.cycle as AsaasCycle)
  );
}

const CHECKOUT_STATUSES = new Set<AsaasCheckoutStatus>(["ACTIVE", "CANCELED", "EXPIRED", "PAID"]);

function isAsaasCheckout(value: unknown): value is AsaasCheckout {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" && item.id.length > 0 &&
    typeof item.link === "string" && item.link.length > 0 &&
    typeof item.status === "string" && CHECKOUT_STATUSES.has(item.status as AsaasCheckoutStatus) &&
    (item.externalReference === undefined || typeof item.externalReference === "string")
  );
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// Valida formato E existência real no calendário (rejeita "2026-02-30"),
// em UTC puro — nunca via `new Date(string)` interpretado em fuso local,
// que pode deslocar o dia dependendo do timezone do processo.
function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Só `id` é obrigatório, igual ao contrato de AsaasPayment — os demais
// campos são opcionais (a Asaas às vezes não os ecoa completamente,
// como description em subscriptions — ver PR #64), mas QUANDO presentes
// precisam ter o tipo/formato certo, senão a resposta inteira é rejeitada
// como invalid_response. Nunca aceita um campo presente e malformado.
function isAsaasPayment(value: unknown): value is AsaasPayment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || item.id.length === 0) return false;
  if (item.status !== undefined && typeof item.status !== "string") return false;
  if (item.customer !== undefined && (typeof item.customer !== "string" || item.customer.length === 0)) return false;
  if (item.subscription !== undefined && (typeof item.subscription !== "string" || item.subscription.length === 0)) {
    return false;
  }
  if (item.value !== undefined && (typeof item.value !== "number" || !Number.isFinite(item.value))) return false;
  if (item.dueDate !== undefined && (typeof item.dueDate !== "string" || !isValidIsoDate(item.dueDate))) return false;
  if (item.deleted !== undefined && typeof item.deleted !== "boolean") return false;
  return true;
}
