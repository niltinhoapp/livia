import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db, sub } from "@/lib/firebase/admin";
import { decryptPaymentConnectionSecret, encryptPaymentConnectionSecret } from "@/lib/payments/connectionCrypto";
import type { PaymentConnection, PaymentConnectionCredentials } from "@/types";

const PROVIDER = "mercado_pago" as const;
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_LEASE_MS = 60 * 1000;
// OAuth é uma única chamada curta num callback HTTP; 10s deixa margem de rede
// sem prender o runtime ou uma lease de refresh por tempo indefinido.
const OAUTH_HTTP_TIMEOUT_MS = 10 * 1000;
const AUTH_URL = "https://auth.mercadopago.com/authorization";
const TOKEN_URL = "https://api.mercadopago.com/oauth/token";

type OAuthState = { id: string; establishmentId: string; provider: typeof PROVIDER; oauthGeneration: number; verifier: ReturnType<typeof encryptPaymentConnectionSecret>; expiresAt: number; consumedAt: number | null; createdAt: number };
type TokenResponse = { access_token: string; refresh_token: string; expires_in?: number; user_id?: string | number; scope?: string };

export class PaymentConnectionError extends Error { constructor(public readonly code: "invalid_state" | "expired_state" | "used_state" | "superseded_state" | "not_found" | "not_connected" | "refresh_in_progress" | "provider_error" | "provider_rejected" | "provider_timeout") { super(code); } }

function config() {
  const clientId = process.env.MERCADO_PAGO_CLIENT_ID?.trim();
  const clientSecret = process.env.MERCADO_PAGO_CLIENT_SECRET?.trim();
  const redirectUri = process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) throw new PaymentConnectionError("provider_error");
  return { clientId, clientSecret, redirectUri };
}
function connectionRef(establishmentId: string) { return sub(establishmentId, "paymentConnections").doc(PROVIDER); }
function credentialsRef(establishmentId: string) { return sub(establishmentId, "paymentConnectionSecrets").doc(PROVIDER); }
function stateRef(state: string) { return db.collection("_paymentOAuthStates").doc(state); }
function verifier() { return randomBytes(48).toString("base64url"); }
function challenge(value: string) { return createHash("sha256").update(value).digest("base64url"); }

async function exchange(body: Record<string, string>): Promise<TokenResponse> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), OAUTH_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const data = await response.json().catch(() => null) as (TokenResponse & { error?: string }) | null;
    // Referência oficial: invalid_grant cobre refresh token inválido/expirado/
    // revogado; forbidden e unauthorized_client representam perda de grant.
    // 429/local_rate_limited e erros de request/configuração são transitórios
    // ou operacionais e jamais desligam uma conta do comerciante.
    const conclusive = response.status === 400 && ["invalid_grant", "forbidden", "unauthorized_client"].includes(data?.error ?? "");
    if (!response.ok || !data?.access_token || !data.refresh_token) throw new PaymentConnectionError(conclusive ? "provider_rejected" : "provider_error");
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new PaymentConnectionError("provider_timeout");
    throw error;
  } finally { clearTimeout(timeout); }
}

export async function beginMercadoPagoOAuth(establishmentId: string): Promise<{ authorizationUrl: string }> {
  const { clientId, redirectUri } = config();
  const state = randomUUID(); const codeVerifier = verifier(); const now = Date.now(); const ref = connectionRef(establishmentId);
  const oauthGeneration = await db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) { const pending: PaymentConnection = { id: PROVIDER, establishmentId, provider: PROVIDER, status: "pending", providerAccountId: null, scopes: [], connectedAt: null, disconnectedAt: null, expiresAt: null, oauthGeneration: 1, createdAt: now, updatedAt: now }; tx.create(ref, pending); return 1; } const current = snap.data() as PaymentConnection; const next = current.oauthGeneration + 1; tx.update(ref, { oauthGeneration: next, updatedAt: now }); return next; });
  const record: OAuthState = { id: state, establishmentId, provider: PROVIDER, oauthGeneration, verifier: encryptPaymentConnectionSecret(codeVerifier), expiresAt: now + STATE_TTL_MS, consumedAt: null, createdAt: now };
  await stateRef(state).create(record);
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge(codeVerifier), code_challenge_method: "S256", platform_id: "mp", scope: "offline_access" }).toString();
  return { authorizationUrl: url.toString() };
}

async function findAndConsumeState(state: string): Promise<OAuthState> {
  const ref = stateRef(state);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); if (!snap.exists) throw new PaymentConnectionError("invalid_state");
    const value = snap.data() as OAuthState;
    if (value.expiresAt <= Date.now()) throw new PaymentConnectionError("expired_state");
    if (value.consumedAt !== null) throw new PaymentConnectionError("used_state");
    tx.update(ref, { consumedAt: Date.now() });
    return value;
  });
}

export async function completeMercadoPagoOAuth(code: string, state: string): Promise<void> {
  const attempt = await findAndConsumeState(state);
  const { clientId, clientSecret, redirectUri } = config();
  const token = await exchange({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: decryptPaymentConnectionSecret(attempt.verifier) });
  const now = Date.now();
  const credentials: PaymentConnectionCredentials = { connectionId: PROVIDER, accessToken: encryptPaymentConnectionSecret(token.access_token), refreshToken: encryptPaymentConnectionSecret(token.refresh_token), updatedAt: now };
  await db.runTransaction(async (tx) => { const ref = connectionRef(attempt.establishmentId); const currentSnap = await tx.get(ref); if (!currentSnap.exists || (currentSnap.data() as PaymentConnection).oauthGeneration !== attempt.oauthGeneration) throw new PaymentConnectionError("superseded_state"); const current = currentSnap.data() as PaymentConnection; const connection: PaymentConnection = { id: PROVIDER, establishmentId: attempt.establishmentId, provider: PROVIDER, status: "connected", providerAccountId: token.user_id == null ? null : String(token.user_id), scopes: token.scope?.split(" ").filter(Boolean) ?? ["offline_access"], connectedAt: now, disconnectedAt: null, expiresAt: typeof token.expires_in === "number" ? now + token.expires_in * 1000 : null, oauthGeneration: attempt.oauthGeneration, createdAt: current.createdAt, updatedAt: now }; tx.set(ref, connection); tx.set(credentialsRef(attempt.establishmentId), credentials); });
}

export async function getMercadoPagoConnection(establishmentId: string): Promise<PaymentConnection | null> { const snap = await connectionRef(establishmentId).get(); return snap.exists ? snap.data() as PaymentConnection : null; }
export async function disconnectMercadoPago(establishmentId: string): Promise<void> { const ref = connectionRef(establishmentId); await db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new PaymentConnectionError("not_found"); tx.update(ref, { status: "disconnected", disconnectedAt: Date.now(), updatedAt: Date.now(), refreshLeaseId: null, refreshLeaseExpiresAt: null }); tx.delete(credentialsRef(establishmentId)); }); }

export async function refreshMercadoPagoConnection(establishmentId: string): Promise<PaymentConnection> {
  const leaseId = randomUUID(); const ref = connectionRef(establishmentId); const secretRef = credentialsRef(establishmentId);
  const claimed = await db.runTransaction(async (tx) => { const [connectionSnap, secretSnap] = await Promise.all([tx.get(ref), tx.get(secretRef)]); if (!connectionSnap.exists || !secretSnap.exists) throw new PaymentConnectionError("not_found"); const connection = connectionSnap.data() as PaymentConnection; if (connection.status !== "connected") throw new PaymentConnectionError("not_connected"); if ((connection.refreshLeaseExpiresAt ?? 0) > Date.now()) throw new PaymentConnectionError("refresh_in_progress"); tx.update(ref, { refreshLeaseId: leaseId, refreshLeaseExpiresAt: Date.now() + REFRESH_LEASE_MS, updatedAt: Date.now() }); return { credentials: secretSnap.data() as PaymentConnectionCredentials, oauthGeneration: connection.oauthGeneration }; });
  const { clientId, clientSecret } = config(); let token: TokenResponse;
  try { token = await exchange({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: decryptPaymentConnectionSecret(claimed.credentials.refreshToken) }); } catch (error) { await db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (snap.exists) { const current = snap.data() as PaymentConnection; if (current.refreshLeaseId === leaseId && current.oauthGeneration === claimed.oauthGeneration) tx.update(ref, { status: error instanceof PaymentConnectionError && error.code === "provider_rejected" ? "requires_reauth" : "connected", refreshLeaseId: null, refreshLeaseExpiresAt: null, updatedAt: Date.now() }); } }); throw error; }
  return db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new PaymentConnectionError("not_found"); const current = snap.data() as PaymentConnection; if (current.refreshLeaseId !== leaseId || current.oauthGeneration !== claimed.oauthGeneration) throw new PaymentConnectionError("refresh_in_progress"); const now = Date.now(); const next: PaymentConnection = { ...current, status: "connected", providerAccountId: token.user_id == null ? current.providerAccountId : String(token.user_id), scopes: token.scope?.split(" ").filter(Boolean) ?? current.scopes, expiresAt: typeof token.expires_in === "number" ? now + token.expires_in * 1000 : null, refreshLeaseId: undefined, refreshLeaseExpiresAt: undefined, updatedAt: now }; tx.set(ref, next); tx.set(secretRef, { connectionId: PROVIDER, accessToken: encryptPaymentConnectionSecret(token.access_token), refreshToken: encryptPaymentConnectionSecret(token.refresh_token), updatedAt: now }); return next; });
}

// Invariável para F12-D+: webhook de sucesso de uma PaymentAttempt superseded
// nunca pode marcar o Payment atual como paid; deve registrar divergência e
// entrar em reconciliation dentro da mesma transação.
