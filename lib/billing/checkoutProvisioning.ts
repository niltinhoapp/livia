// Provisionamento do Hosted Checkout (cartão de crédito) — irmão de
// provisioning.ts (que continua intocado e exclusivo do caminho PIX direto).
// Mesmo padrão de idempotência (reserva por doc + lease + transaction), mas
// adaptado a uma diferença fundamental confirmada empiricamente no Asaas
// Sandbox (OT de migração pro Hosted Checkout):
//
//   1. Criar um Checkout NUNCA cria uma subscription/cobrança por si só — só
//      depois que o cliente paga na página hospedada. Por isso não há
//      "reconciliação" aqui como em provisioning.ts (que já nasce sabendo
//      que o POST criou uma cobrança real); há só "o Checkout foi criado
//      com sucesso" (phase "created") — o resto (subscription, payment,
//      billingStatus) é tratado inteiramente pelo webhook.
//   2. O `externalReference` que enviamos ao criar o Checkout NÃO se
//      propaga para a subscription nem para o payment resultantes
//      (confirmado no Sandbox: ambos vêm com externalReference=null). A
//      Asaas correlaciona por um campo diferente, `checkoutSession`
//      (= o id do Checkout), presente tanto na subscription quanto no
//      payment. Por isso este módulo persiste o vínculo
//      checkoutId -> (establishmentId, generation) num documento à parte
//      (_asaas_checkout_correlations), ANTES de qualquer redirecionamento
//      do navegador — é esse vínculo que o webhook consulta quando
//      externalReference não resolve (ver asaasWebhookProcessing.ts).
//   3. Sem endpoint confirmado de "GET checkout por id" (testado no
//      Sandbox: 404), não há como reconciliar um POST cujo resultado se
//      perdeu (timeout/rede) verificando o que já existe do lado da Asaas,
//      diferente de provisioning.ts. Isso é aceitável aqui porque criar um
//      Checkout duplicado não tem custo financeiro nem cria uma segunda
//      assinatura — só uma segunda página de pagamento não utilizada; quem
//      protege contra assinatura duplicada é o par
//      (checkoutId -> establishment) + a autoridade exclusiva do webhook,
//      nunca a criação do Checkout em si.
import { db } from "@/lib/firebase/admin";
import { createHash } from "node:crypto";
import type { AsaasClient, AsaasCycle, AsaasError } from "./asaas";

export type BillingCheckoutPhase = "reserved" | "creating" | "created" | "conflict" | "failed_terminal";

export interface CheckoutTerms {
  value: number;
  cycle: AsaasCycle;
  nextDueDate: string;
}

export interface SanitizedCheckoutError {
  kind: AsaasError["kind"] | "conflict";
  status?: number;
  codes?: string[];
  descriptions?: string[];
  code?: string;
}

export interface BillingCheckoutIntent {
  operationId: string;
  establishmentId: string;
  subscriptionGeneration: number;
  // Só auditoria/bookkeeping do lado da Lívia — a Asaas NUNCA propaga este
  // valor para a subscription/payment (ver cabeçalho). Namespace
  // deliberadamente distinto de logicalSubscriptionExternalReference
  // (provisioning.ts) para nunca ser confundido com uma referência de
  // subscription PIX por resolveEstablishmentFromExternalReference.
  externalReference: string;
  fingerprint: string;
  terms: CheckoutTerms;
  phase: BillingCheckoutPhase;
  attemptId: string | null;
  leaseId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  checkoutId: string | null;
  checkoutLink: string | null;
  checkoutCreatedAt: number | null;
  checkoutExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastError: SanitizedCheckoutError | null;
}

export interface ProvisionCheckoutInput {
  establishmentId: string;
  subscriptionGeneration: number;
  leaseOwner: string;
  value: number;
  cycle: AsaasCycle;
  nextDueDate: string;
  successUrl: string;
  cancelUrl: string;
  expiredUrl?: string;
  minutesToExpire?: number;
  leaseDurationMs?: number;
}

type CheckoutClient = Pick<AsaasClient, "createCheckout">;

export interface CheckoutProvisioningDependencies {
  asaas: CheckoutClient;
  now: () => number;
  newId: () => string;
}

export type CheckoutProvisioningResult =
  | { ok: true; phase: "created"; outcome: "created" | "reused"; intent: BillingCheckoutIntent }
  | { ok: true; phase: "reserved" | "creating"; outcome: "busy"; intent: BillingCheckoutIntent }
  | { ok: false; phase: "conflict" | "failed_terminal"; reason: string; intent?: BillingCheckoutIntent };

interface CheckoutIdentity {
  operationId: string;
  establishmentId: string;
  subscriptionGeneration: number;
  externalReference: string;
  fingerprint: string;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MINUTES_TO_EXPIRE = 60;

function validateLogicalIdentity(establishmentId: string, generation: number): void {
  if (!establishmentId || establishmentId.includes("/")) {
    throw new Error("Checkout provisioning: establishmentId inválido.");
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Checkout provisioning: generation deve ser inteiro positivo.");
  }
}

export function logicalCheckoutExternalReference(establishmentId: string, generation: number): string {
  validateLogicalIdentity(establishmentId, generation);
  return `livia:checkout:${establishmentId}:${generation}`;
}

export function logicalCheckoutOperationId(establishmentId: string, generation: number): string {
  validateLogicalIdentity(establishmentId, generation);
  return `${establishmentId}:${generation}`;
}

function validateTerms(terms: CheckoutTerms): void {
  if (!Number.isFinite(terms.value) || terms.value <= 0) {
    throw new Error("Checkout provisioning: value deve ser positivo e finito.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(terms.nextDueDate)) {
    throw new Error("Checkout provisioning: nextDueDate inválido.");
  }
}

export function checkoutFingerprint(terms: CheckoutTerms): string {
  validateTerms(terms);
  const canonical = JSON.stringify(["checkout-v1", "CREDIT_CARD", Math.round(terms.value * 100), terms.cycle, terms.nextDueDate]);
  return createHash("sha256").update(canonical).digest("hex");
}

function intentRef(establishmentId: string, generation: number) {
  return db.collection("establishments").doc(establishmentId).collection("billingCheckout").doc(String(generation));
}

// Documento à parte, fora da árvore de establishments: é exatamente o
// vínculo que o webhook precisa achar a partir de um checkoutSession vindo
// de um evento Asaas, sem nenhuma pista de qual establishment ele pertence
// além deste registro. Nunca escrito por mais de um caminho (só
// provisionBillingCheckout, e só com .create() — nunca update) — proteção
// contra colisão/reuso: se o mesmo checkoutId já estiver vinculado a outro
// establishment (não deveria nunca acontecer, ids são UUID da Asaas), a
// escrita falha ao invés de sobrescrever silenciosamente.
function checkoutCorrelationRef(checkoutId: string) {
  return db.collection("_asaas_checkout_correlations").doc(checkoutId);
}

export interface CheckoutCorrelation {
  establishmentId: string;
  subscriptionGeneration: number;
  createdAt: number;
}

export async function resolveCheckoutCorrelation(
  checkoutId: string,
): Promise<CheckoutCorrelation | null> {
  const snap = await checkoutCorrelationRef(checkoutId).get();
  return snap.exists ? (snap.data() as CheckoutCorrelation) : null;
}

function identityOf(intent: BillingCheckoutIntent): CheckoutIdentity {
  return {
    operationId: intent.operationId,
    establishmentId: intent.establishmentId,
    subscriptionGeneration: intent.subscriptionGeneration,
    externalReference: intent.externalReference,
    fingerprint: intent.fingerprint,
  };
}

function identityMatches(intent: BillingCheckoutIntent, expected: CheckoutIdentity): boolean {
  return (
    intent.operationId === expected.operationId &&
    intent.establishmentId === expected.establishmentId &&
    intent.subscriptionGeneration === expected.subscriptionGeneration &&
    intent.externalReference === expected.externalReference &&
    intent.fingerprint === expected.fingerprint
  );
}

function seedIntent(input: ProvisionCheckoutInput, now: number): BillingCheckoutIntent {
  const externalReference = logicalCheckoutExternalReference(input.establishmentId, input.subscriptionGeneration);
  const terms: CheckoutTerms = { value: input.value, cycle: input.cycle, nextDueDate: input.nextDueDate };
  return {
    operationId: logicalCheckoutOperationId(input.establishmentId, input.subscriptionGeneration),
    establishmentId: input.establishmentId,
    subscriptionGeneration: input.subscriptionGeneration,
    externalReference,
    fingerprint: checkoutFingerprint(terms),
    terms,
    phase: "reserved",
    attemptId: null,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkoutId: null,
    checkoutLink: null,
    checkoutCreatedAt: null,
    checkoutExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
}

async function reserveIntent(seed: BillingCheckoutIntent): Promise<
  | { ok: true; intent: BillingCheckoutIntent }
  | { ok: false; reason: "identity_conflict"; intent: BillingCheckoutIntent }
> {
  const ref = intentRef(seed.establishmentId, seed.subscriptionGeneration);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const current = snap.data() as BillingCheckoutIntent;
      return identityMatches(current, identityOf(seed))
        ? { ok: true as const, intent: current }
        : { ok: false as const, reason: "identity_conflict" as const, intent: current };
    }
    tx.create(ref, seed);
    return { ok: true as const, intent: seed };
  });
}

async function acquireLease(
  identity: CheckoutIdentity,
  leaseId: string,
  leaseOwner: string,
  now: number,
  leaseDurationMs: number,
): Promise<{ acquired: boolean; intent: BillingCheckoutIntent } | null> {
  const ref = intentRef(identity.establishmentId, identity.subscriptionGeneration);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as BillingCheckoutIntent;
    if (!identityMatches(current, identity)) return null;
    if (current.phase === "conflict" || current.phase === "failed_terminal") {
      return { acquired: false, intent: current };
    }
    // "created" com checkout ainda válido nunca chega aqui (o chamador já
    // devolve outcome "reused" antes de tentar lease) — só "created" com
    // checkout JÁ expirado passa por aqui, e é elegível pra nova tentativa.
    if (current.leaseId && current.leaseExpiresAt !== null && current.leaseExpiresAt > now) {
      return { acquired: false, intent: current };
    }
    const leased: BillingCheckoutIntent = {
      ...current,
      leaseId,
      leaseOwner,
      leaseExpiresAt: now + leaseDurationMs,
      updatedAt: now,
    };
    tx.update(ref, { leaseId, leaseOwner, leaseExpiresAt: leased.leaseExpiresAt, updatedAt: now });
    return { acquired: true, intent: leased };
  });
}

async function transitionWithLease(
  identity: CheckoutIdentity,
  leaseId: string,
  update: (current: BillingCheckoutIntent) => Partial<BillingCheckoutIntent> | null,
): Promise<BillingCheckoutIntent | null> {
  const ref = intentRef(identity.establishmentId, identity.subscriptionGeneration);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as BillingCheckoutIntent;
    if (!identityMatches(current, identity) || current.leaseId !== leaseId) return null;
    const patch = update(current);
    if (!patch) return null;
    tx.update(ref, patch);
    return { ...current, ...patch };
  });
}

function sanitizedError(error: AsaasError): SanitizedCheckoutError {
  const descriptions = error.errors?.map((item) => item.description).filter((d): d is string => Boolean(d));
  return {
    kind: error.kind,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.errors
      ? { codes: error.errors.map((item) => item.code).filter((code): code is string => Boolean(code)) }
      : {}),
    ...(descriptions?.length ? { descriptions } : {}),
  };
}

function isConclusiveHttpRejection(error: AsaasError): boolean {
  return error.kind === "http" && [400, 401, 403, 404, 422].includes(error.status ?? 0);
}

export async function provisionBillingCheckout(
  input: ProvisionCheckoutInput,
  deps: CheckoutProvisioningDependencies,
): Promise<CheckoutProvisioningResult> {
  if (!input.leaseOwner) {
    throw new Error("Checkout provisioning: leaseOwner é obrigatório.");
  }
  const initialNow = deps.now();
  const seed = seedIntent(input, initialNow);
  const identity = identityOf(seed);
  const reservation = await reserveIntent(seed);
  if (!reservation.ok) {
    return { ok: false, phase: "conflict", reason: reservation.reason, intent: reservation.intent };
  }

  const current = reservation.intent;
  const now = deps.now();
  // Checkout já criado e ainda dentro da validade: idempotente por
  // construção — double-click, refresh ou retry da MESMA tentativa nunca
  // criam um segundo Checkout, só devolvem o mesmo link já persistido.
  if (current.checkoutId && current.checkoutLink && current.checkoutExpiresAt !== null && current.checkoutExpiresAt > now) {
    return { ok: true, phase: "created", outcome: "reused", intent: current };
  }

  const leaseId = deps.newId();
  const acquired = await acquireLease(identity, leaseId, input.leaseOwner, now, input.leaseDurationMs ?? DEFAULT_LEASE_MS);
  if (!acquired) return { ok: false, phase: "conflict", reason: "intent_changed" };
  if (!acquired.acquired) {
    if (acquired.intent.phase === "conflict" || acquired.intent.phase === "failed_terminal") {
      return { ok: false, phase: acquired.intent.phase, reason: acquired.intent.phase, intent: acquired.intent };
    }
    return { ok: true, phase: acquired.intent.phase === "creating" ? "creating" : "reserved", outcome: "busy", intent: acquired.intent };
  }

  const attemptId = deps.newId();
  const creating = await transitionWithLease(identity, leaseId, (c) => {
    if (c.attemptId !== null && c.phase === "creating") return null;
    return { phase: "creating", attemptId, updatedAt: deps.now() };
  });
  if (!creating) return { ok: false, phase: "conflict", reason: "intent_changed" };

  const minutesToExpire = input.minutesToExpire ?? DEFAULT_MINUTES_TO_EXPIRE;
  const created = await deps.asaas.createCheckout({
    billingTypes: ["CREDIT_CARD"],
    chargeTypes: ["RECURRENT"],
    externalReference: seed.externalReference,
    minutesToExpire,
    callback: {
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      ...(input.expiredUrl !== undefined ? { expiredUrl: input.expiredUrl } : {}),
    },
    items: [{ name: "Lívia — assinatura mensal", quantity: 1, value: input.value }],
    subscription: { cycle: input.cycle, nextDueDate: input.nextDueDate },
  });

  if (!created.ok) {
    const terminal = isConclusiveHttpRejection(created.error);
    // Sem endpoint de reconciliação (ver cabeçalho do arquivo): em falha
    // NÃO terminal (timeout/rede/5xx), volta pra "reserved" — permite um
    // retry pleno (novo POST) na próxima chamada. Isso é seguro aqui porque
    // um Checkout "perdido" nunca é uma assinatura/cobrança real — na pior
    // hipótese sobra uma página de pagamento nunca usada.
    const failed = await transitionWithLease(identity, leaseId, (c) => {
      if (c.attemptId !== attemptId || c.phase !== "creating") return null;
      return {
        phase: terminal ? "failed_terminal" : "reserved",
        attemptId: terminal ? c.attemptId : null,
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: deps.now(),
        lastError: sanitizedError(created.error),
      };
    });
    if (!failed) return { ok: false, phase: "conflict", reason: "intent_changed" };
    return terminal
      ? { ok: false, phase: "failed_terminal", reason: "asaas_rejected", intent: failed }
      : { ok: true, phase: "reserved", outcome: "busy", intent: failed };
  }

  const checkoutCreatedAt = deps.now();
  const checkoutExpiresAt = checkoutCreatedAt + minutesToExpire * 60_000;
  const checkoutId = created.data.id;
  const checkoutLink = created.data.link;

  // ÚNICA transação que persiste o vínculo checkoutId -> establishment,
  // ATÔMICA com a atualização do intent — nunca existe um checkoutId
  // devolvido ao chamador (que vai redirecionar o navegador pra lá) sem o
  // vínculo já persistido, e nunca existe o vínculo sem o intent
  // correspondente já em phase "created".
  const succeeded = await db.runTransaction(async (tx) => {
    const ref = intentRef(identity.establishmentId, identity.subscriptionGeneration);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const c = snap.data() as BillingCheckoutIntent;
    if (!identityMatches(c, identity) || c.leaseId !== leaseId || c.attemptId !== attemptId || c.phase !== "creating") {
      return null;
    }
    const patch: Partial<BillingCheckoutIntent> = {
      phase: "created",
      checkoutId,
      checkoutLink,
      checkoutCreatedAt,
      checkoutExpiresAt,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: checkoutCreatedAt,
      lastError: null,
    };
    tx.update(ref, patch);
    tx.create(checkoutCorrelationRef(checkoutId), {
      establishmentId: identity.establishmentId,
      subscriptionGeneration: identity.subscriptionGeneration,
      createdAt: checkoutCreatedAt,
    } satisfies CheckoutCorrelation);
    return { ...c, ...patch };
  });
  if (!succeeded) return { ok: false, phase: "conflict", reason: "intent_changed" };
  return { ok: true, phase: "created", outcome: "created", intent: succeeded };
}

export async function getBillingCheckoutIntent(
  establishmentId: string,
  generation: number,
): Promise<BillingCheckoutIntent | null> {
  const snap = await intentRef(establishmentId, generation).get();
  return snap.exists ? (snap.data() as BillingCheckoutIntent) : null;
}
