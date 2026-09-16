// Harness temporário e dormente para homologação controlada no Asaas Sandbox.
// Nenhuma rota de produto, cron ou webhook importa este módulo. A única rota
// interna que o usa aplica autenticação de platform admin e confirmação
// explícita antes de construir o client.
import { randomUUID } from "node:crypto";
import { createAsaasClient, type AsaasClient, type AsaasError, type AsaasPayment } from "./asaas";
import type {
  BillingProvisioningIntent,
  ConflictRecoveryDependencies,
  ProvisioningResult,
  getBillingProvisioningIntent,
  logicalSubscriptionExternalReference,
  provisionAsaasSubscription,
  reconcileConflictedSubscription,
} from "./provisioning";
import type { provisionSandboxCustomer } from "./asaasSandboxCustomer";
import type { Establishment } from "@/types";

const SANDBOX_KEY_PREFIX = "$aact_hmlg_";
const TEST_RUN_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;
const CUSTOMER_ID = /^[A-Za-z0-9_-]{3,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Allowlist mínima e explícita para homologação. PIX foi o billingType da
// generation 1 (HTTP 400 invalid_value); BOLETO é a segunda variável a testar.
// CREDIT_CARD e UNDEFINED são excluídos deliberadamente: a Lívia não manipula
// dado de cartão nesta fase e UNDEFINED não é um alvo de homologação.
const HARNESS_BILLING_TYPES = new Set(["PIX", "BOLETO"]);

// Limite conservador que dá margem ampla para homologação sem abrir escopo
// ilimitado. Gerations fora de 1–10 são rejeitadas pelo parser.
const GENERATION_MIN = 1;
const GENERATION_MAX = 10;

// Valor mínimo confirmado pelo Asaas Sandbox para BOLETO (OT-05H-K: "O valor
// mínimo para cobranças via Boleto Bancário é R$ 5,00."). Aplicado a todos
// os billingTypes para manter consistência e evitar rejeições silenciosas.
const HARNESS_VALUE_MIN = 5;

export interface SandboxHarnessEnvironment {
  VERCEL_ENV?: string;
  ASAAS_ENVIRONMENT?: string;
  ASAAS_API_KEY?: string;
}

// VERCEL_ENV aceita "preview" OU "production" (OT-06G) — decisão temporária
// da fase pré-beta: Production do APP está sendo usada como ambiente de
// homologação, mas SEMPRE contra o Asaas Sandbox, nunca Asaas Production.
// Isso não abre brecha para chamar api.asaas.com: os dois checks abaixo
// (ASAAS_ENVIRONMENT + prefixo da chave) continuam obrigatórios, e — mais
// forte ainda — createSandboxHarnessDependencies() hardcoda
// `environment: "sandbox"` como string literal ao construir o AsaasClient
// (nunca lê ASAAS_ENVIRONMENT para escolher a URL base), e createAsaasClient
// por sua vez lança exceção se a chave não tiver o prefixo sandbox. VERCEL_ENV
// aqui só controla SE a rota responde, nunca PARA ONDE ela chama. Quando a
// fase pré-beta acabar (clientes reais entrando), esta OT deve ser revertida
// junto com a separação real Preview/Production (ver OT-06F).
export function isAsaasSandboxHarnessEnabled(env: SandboxHarnessEnvironment): boolean {
  return (
    (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "production") &&
    env.ASAAS_ENVIRONMENT === "sandbox" &&
    typeof env.ASAAS_API_KEY === "string" &&
    env.ASAAS_API_KEY.startsWith(SANDBOX_KEY_PREFIX)
  );
}

// billingType permitido explicitamente pelo harness de homologação.
// Subconjunto intencional de AsaasBillingType — não exporta todos os valores
// do tipo compartilhado para não confundir com o contrato de Production.
export type HarnessBillingType = "PIX" | "BOLETO";

export type SandboxHarnessCommand =
  | { action: "auth_check"; confirmSandbox: true }
  | { action: "customer"; confirmSandbox: true; testRunId: string; cpfCnpj: string }
  | {
      action: "subscription";
      confirmSandbox: true;
      testRunId: string;
      customerId: string;
      nextDueDate: string;
      generation: number;
      billingType: HarnessBillingType;
      value: number;
    }
  | {
      action: "inspect";
      confirmSandbox: true;
      testRunId: string;
      customerId: string;
      generation: number;
    }
  | {
      action: "conflict_recovery";
      confirmSandbox: true;
      testRunId: string;
      generation: number;
    };

export type SandboxHarnessFailureCode =
  | "customer_conflict"
  | "customer_lookup_failed"
  | "customer_create_rejected"
  | "invalid_customer_response"
  | "test_establishment_not_found"
  | "test_establishment_invalid"
  | "subscription_conflict"
  | "subscription_lookup_failed"
  | "payments_lookup_failed"
  | "recovery_conflict";

export type SandboxHarnessResult =
  | { ok: true; action: "auth_check"; authenticated: true }
  | {
      ok: true;
      action: "customer";
      outcome: "created" | "reused" | "reconciled" | "reconciling" | "verification_failed";
      customer: { id: string | null; externalReference: string };
    }
  | {
      ok: true;
      action: "subscription";
      phase: ProvisioningResult["phase"];
      outcome?: string;
      generation: number;
      externalSubscriptionId: string | null;
    }
  | {
      ok: true;
      action: "inspect";
      customer: { id: string; externalReference: string } | null;
      subscription: {
        id: string;
        customer: string | null;
        externalReference: string | null;
        billingType: string | null;
        value: number | null;
        cycle: string | null;
        nextDueDate: string | null;
        description: string | null;
        status: string | null;
      } | null;
      provisioning: {
        phase: BillingProvisioningIntent["phase"];
        generation: number;
        externalSubscriptionId: string | null;
      } | null;
      payments: Array<{
        id: string;
        status: string | null;
        dueDate: string | null;
        value: number | null;
        customer: string | null;
        subscription: string | null;
        deleted: boolean | null;
      }>;
    }
  | {
      ok: true;
      action: "conflict_recovery";
      phase: "succeeded";
      generation: number;
      externalSubscriptionId: string;
    }
  | {
      ok: false;
      action: SandboxHarnessCommand["action"];
      code: SandboxHarnessFailureCode | "asaas_auth_failed";
      upstream?: SanitizedAsaasError;
    };

export interface SanitizedAsaasError {
  kind: AsaasError["kind"];
  status?: number;
  codes?: string[];
}

export interface SandboxHarnessDependencies {
  asaas: AsaasClient;
  getEstablishment: (id: string) => Promise<Establishment | null>;
  provisionSubscription: typeof provisionAsaasSubscription;
  provisionCustomer: typeof provisionSandboxCustomer;
  getProvisioningIntent: typeof getBillingProvisioningIntent;
  logicalSubscriptionExternalReference: typeof logicalSubscriptionExternalReference;
  recoverConflict: typeof reconcileConflictedSubscription;
  now: () => number;
  newId: () => string;
}

export async function createSandboxHarnessDependencies(apiKey: string): Promise<SandboxHarnessDependencies> {
  // Imports Firestore/repository only after auth, confirmation and kill switch
  // have all passed in the route. This keeps every blocked request entirely
  // outside both Asaas and Firestore business operations.
  const [{ getEstablishment }, provisioning, customerProvisioning] = await Promise.all([
    import("@/lib/repo"),
    import("./provisioning"),
    import("./asaasSandboxCustomer"),
  ]);
  return {
    asaas: createAsaasClient({ environment: "sandbox", apiKey }),
    getEstablishment,
    provisionSubscription: provisioning.provisionAsaasSubscription,
    provisionCustomer: customerProvisioning.provisionSandboxCustomer,
    getProvisioningIntent: provisioning.getBillingProvisioningIntent,
    logicalSubscriptionExternalReference: provisioning.logicalSubscriptionExternalReference,
    recoverConflict: provisioning.reconcileConflictedSubscription,
    now: Date.now,
    newId: randomUUID,
  };
}

export function sandboxCustomerExternalReference(testRunId: string): string {
  return `livia:sandbox-test:${testRunId}:customer`;
}

export function sandboxTestEstablishmentId(testRunId: string): string {
  return `asaas-sandbox-test-${testRunId}`;
}

function sanitizeAsaasError(error: AsaasError): SanitizedAsaasError {
  const codes = error.errors?.map((item) => item.code).filter((code): code is string => Boolean(code));
  return {
    kind: error.kind,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(codes?.length ? { codes } : {}),
  };
}

function validCustomerId(value: unknown): value is string {
  return typeof value === "string" && CUSTOMER_ID.test(value);
}

async function requireDedicatedTestEstablishment(
  testRunId: string,
  deps: SandboxHarnessDependencies,
): Promise<Establishment | SandboxHarnessFailureCode> {
  const expectedId = sandboxTestEstablishmentId(testRunId);
  const establishment = await deps.getEstablishment(expectedId);
  if (!establishment) return "test_establishment_not_found";
  if (establishment.id !== expectedId || establishment.ownerUid !== expectedId) {
    return "test_establishment_invalid";
  }
  return establishment;
}

async function ensureCustomer(
  command: Extract<SandboxHarnessCommand, { action: "customer" }>,
  deps: SandboxHarnessDependencies,
): Promise<SandboxHarnessResult> {
  const externalReference = sandboxCustomerExternalReference(command.testRunId);
  const result = await deps.provisionCustomer({
    testRunId: command.testRunId,
    externalReference,
    name: `Livia Sandbox Test ${command.testRunId}`,
    cpfCnpj: command.cpfCnpj,
  }, { asaas: deps.asaas, now: deps.now, newId: deps.newId });

  if (!result.ok) {
    return {
      ok: false,
      action: "customer",
      code: result.phase === "failed_terminal" ? "customer_create_rejected" : "customer_conflict",
    };
  }
  if (result.phase !== "succeeded") {
    if (result.outcome === "lookup_failed" && result.phase === "reserved") {
      return { ok: false, action: "customer", code: "customer_lookup_failed" };
    }
    return {
      ok: true,
      action: "customer",
      outcome: "reconciling",
      customer: { id: null, externalReference },
    };
  }
  return {
    ok: true,
    action: "customer",
    outcome: result.outcome === "verified" ? "reused" : result.outcome,
    customer: { id: result.intent.externalCustomerId, externalReference },
  };
}

async function provisionSubscription(
  command: Extract<SandboxHarnessCommand, { action: "subscription" }>,
  deps: SandboxHarnessDependencies,
): Promise<SandboxHarnessResult> {
  const customerReference = sandboxCustomerExternalReference(command.testRunId);
  const customers = await deps.asaas.findCustomersByExternalReference(customerReference);
  if (!customers.ok) {
    return {
      ok: false,
      action: "subscription",
      code: "customer_lookup_failed",
      upstream: sanitizeAsaasError(customers.error),
    };
  }
  if (customers.data.length !== 1 || customers.data[0]?.id !== command.customerId) {
    return { ok: false, action: "subscription", code: "customer_conflict" };
  }

  const establishment = await requireDedicatedTestEstablishment(command.testRunId, deps);
  if (typeof establishment === "string") {
    return { ok: false, action: "subscription", code: establishment };
  }

  const result = await deps.provisionSubscription(
    {
      establishmentId: establishment.id,
      subscriptionGeneration: command.generation,
      asaasCustomerId: command.customerId,
      leaseOwner: "asaas-sandbox-harness",
      billingType: command.billingType,
      value: command.value,
      cycle: "MONTHLY",
      nextDueDate: command.nextDueDate,
      description: "Livia sandbox controlled test",
    },
    { asaas: deps.asaas, now: deps.now, newId: deps.newId },
  );

  if (!result.ok) {
    return { ok: false, action: "subscription", code: "subscription_conflict" };
  }
  return {
    ok: true,
    action: "subscription",
    phase: result.phase,
    outcome: result.outcome,
    generation: command.generation,
    externalSubscriptionId: result.intent.externalSubscriptionId,
  };
}

async function recoverConflict(
  command: Extract<SandboxHarnessCommand, { action: "conflict_recovery" }>,
  deps: SandboxHarnessDependencies,
): Promise<SandboxHarnessResult> {
  const establishment = await requireDedicatedTestEstablishment(command.testRunId, deps);
  if (typeof establishment === "string") {
    return { ok: false, action: "conflict_recovery", code: establishment };
  }

  const result = await deps.recoverConflict(
    establishment.id,
    command.generation,
    "asaas-sandbox-harness",
    {
      asaas: deps.asaas,
      now: deps.now,
      newId: deps.newId,
    } satisfies ConflictRecoveryDependencies,
  );

  if (!result.ok) {
    return { ok: false, action: "conflict_recovery", code: "recovery_conflict" };
  }

  const externalSubscriptionId = result.intent?.externalSubscriptionId;
  if (!externalSubscriptionId) {
    return { ok: false, action: "conflict_recovery", code: "recovery_conflict" };
  }

  return {
    ok: true,
    action: "conflict_recovery",
    phase: "succeeded",
    generation: command.generation,
    externalSubscriptionId,
  };
}

async function inspect(
  command: Extract<SandboxHarnessCommand, { action: "inspect" }>,
  deps: SandboxHarnessDependencies,
): Promise<SandboxHarnessResult> {
  const establishment = await requireDedicatedTestEstablishment(command.testRunId, deps);
  if (typeof establishment === "string") return { ok: false, action: "inspect", code: establishment };

  const externalReference = sandboxCustomerExternalReference(command.testRunId);
  const customers = await deps.asaas.findCustomersByExternalReference(externalReference);
  if (!customers.ok) {
    return {
      ok: false,
      action: "inspect",
      code: "customer_lookup_failed",
      upstream: sanitizeAsaasError(customers.error),
    };
  }
  if (customers.data.length > 1) return { ok: false, action: "inspect", code: "customer_conflict" };

  const customer = customers.data[0];
  if (customer && !validCustomerId(customer.id)) {
    return { ok: false, action: "inspect", code: "invalid_customer_response" };
  }
  if (customer && customer.id !== command.customerId) {
    return { ok: false, action: "inspect", code: "customer_conflict" };
  }

  const intent = await deps.getProvisioningIntent(establishment.id, command.generation);
  const logicalReference = deps.logicalSubscriptionExternalReference(establishment.id, command.generation);
  let subscription = null;
  if (intent?.externalSubscriptionId) {
    const found = await deps.asaas.getSubscription(intent.externalSubscriptionId);
    if (!found.ok) {
      return {
        ok: false,
        action: "inspect",
        code: "subscription_lookup_failed",
        upstream: sanitizeAsaasError(found.error),
      };
    }
    subscription = found.data;
  } else {
    const found = await deps.asaas.findSubscriptionsForReconciliation({
      customer: command.customerId,
      externalReference: logicalReference,
      includeDeleted: true,
    });
    if (!found.ok) {
      return {
        ok: false,
        action: "inspect",
        code: "subscription_lookup_failed",
        upstream: sanitizeAsaasError(found.error),
      };
    }
    if (found.data.length > 1) return { ok: false, action: "inspect", code: "subscription_conflict" };
    subscription = found.data[0] ?? null;
  }

  let payments: AsaasPayment[] = [];
  if (subscription) {
    const found = await deps.asaas.listSubscriptionPayments(subscription.id);
    if (!found.ok) {
      return {
        ok: false,
        action: "inspect",
        code: "payments_lookup_failed",
        upstream: sanitizeAsaasError(found.error),
      };
    }
    payments = found.data;
  }

  return {
    ok: true,
    action: "inspect",
    customer: customer ? { id: customer.id, externalReference } : null,
    subscription: subscription
      ? {
          id: subscription.id,
          customer: subscription.customer ?? null,
          externalReference: subscription.externalReference ?? null,
          billingType: subscription.billingType ?? null,
          value: subscription.value ?? null,
          cycle: subscription.cycle ?? null,
          nextDueDate: subscription.nextDueDate ?? null,
          description: subscription.description ?? null,
          status: subscription.status ?? null,
        }
      : null,
    provisioning: intent
      ? {
          phase: intent.phase,
          generation: intent.subscriptionGeneration,
          externalSubscriptionId: intent.externalSubscriptionId,
        }
      : null,
    payments: payments.map((payment) => ({
      id: payment.id,
      status: payment.status ?? null,
      dueDate: payment.dueDate ?? null,
      value: payment.value ?? null,
      customer: payment.customer ?? null,
      subscription: payment.subscription ?? null,
      deleted: payment.deleted ?? null,
    })),
  };
}

export async function executeAsaasSandboxHarness(
  command: SandboxHarnessCommand,
  deps: SandboxHarnessDependencies,
): Promise<SandboxHarnessResult> {
  if (command.action === "auth_check") {
    const result = await deps.asaas.checkAuthentication();
    return result.ok
      ? { ok: true, action: "auth_check", authenticated: true }
      : {
          ok: false,
          action: "auth_check",
          code: "asaas_auth_failed",
          upstream: sanitizeAsaasError(result.error),
        };
  }
  if (command.action === "customer") return ensureCustomer(command, deps);
  if (command.action === "subscription") return provisionSubscription(command, deps);
  if (command.action === "conflict_recovery") return recoverConflict(command, deps);
  return inspect(command, deps);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validGeneration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= GENERATION_MIN &&
    value <= GENERATION_MAX
  );
}

function validHarnessBillingType(value: unknown): value is HarnessBillingType {
  return typeof value === "string" && HARNESS_BILLING_TYPES.has(value);
}

function validHarnessValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= HARNESS_VALUE_MIN;
}

export function parseSandboxHarnessCommand(value: unknown): SandboxHarnessCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.confirmSandbox !== true || typeof raw.action !== "string") return null;

  if (raw.action === "auth_check") {
    return exactKeys(raw, ["action", "confirmSandbox"]) ? { action: "auth_check", confirmSandbox: true } : null;
  }
  if (raw.action === "customer") {
    if (!exactKeys(raw, ["action", "confirmSandbox", "testRunId", "cpfCnpj"])) return null;
    if (typeof raw.testRunId !== "string" || !TEST_RUN_ID.test(raw.testRunId)) return null;
    if (typeof raw.cpfCnpj !== "string" || !/^(?:\d{11}|\d{14})$/.test(raw.cpfCnpj)) return null;
    return raw as SandboxHarnessCommand;
  }
  if (raw.action === "subscription") {
    if (!exactKeys(raw, ["action", "confirmSandbox", "testRunId", "customerId", "nextDueDate", "generation", "billingType", "value"])) return null;
    if (typeof raw.testRunId !== "string" || !TEST_RUN_ID.test(raw.testRunId)) return null;
    if (typeof raw.customerId !== "string" || !CUSTOMER_ID.test(raw.customerId)) return null;
    if (typeof raw.nextDueDate !== "string" || !ISO_DATE.test(raw.nextDueDate)) return null;
    if (!validGeneration(raw.generation)) return null;
    if (!validHarnessBillingType(raw.billingType)) return null;
    if (!validHarnessValue(raw.value)) return null;
    return raw as SandboxHarnessCommand;
  }
  if (raw.action === "inspect") {
    if (!exactKeys(raw, ["action", "confirmSandbox", "testRunId", "customerId", "generation"])) return null;
    if (typeof raw.testRunId !== "string" || !TEST_RUN_ID.test(raw.testRunId)) return null;
    if (typeof raw.customerId !== "string" || !CUSTOMER_ID.test(raw.customerId)) return null;
    if (!validGeneration(raw.generation)) return null;
    return raw as SandboxHarnessCommand;
  }
  if (raw.action === "conflict_recovery") {
    if (!exactKeys(raw, ["action", "confirmSandbox", "testRunId", "generation"])) return null;
    if (typeof raw.testRunId !== "string" || !TEST_RUN_ID.test(raw.testRunId)) return null;
    if (typeof raw.generation !== "number" || !Number.isInteger(raw.generation) || raw.generation < 1) return null;
    return raw as SandboxHarnessCommand;
  }
  return null;
}
