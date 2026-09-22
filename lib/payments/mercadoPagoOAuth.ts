import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db, sub } from "@/lib/firebase/admin";
import { decryptPaymentConnectionSecret, encryptPaymentConnectionSecret } from "@/lib/payments/connectionCrypto";
import type { PaymentConnection, PaymentConnectionCredentials } from "@/types";

const PROVIDER = "mercado_pago" as const;
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_LEASE_MS = 60 * 1000;
const AUTH_URL = "https://auth.mercadopago.com/authorization";
const TOKEN_URL = "https://api.mercadopago.com/oauth/token";

type OAuthState = { id: string; establishmentId: string; provider: typeof PROVIDER; verifier: ReturnType<typeof encryptPaymentConnectionSecret>; expiresAt: number; consumedAt: number | null; createdAt: number };
type TokenResponse = { access_token: string; refresh_token: string; expires_in?: number; user_id?: string | number; scope?: string };

export class PaymentConnectionError extends Error { constructor(public readonly code: "invalid_state" | "expired_state" | "used_state" | "not_found" | "not_connected" | "refresh_in_progress" | "provider_error" | "provider_rejected") { super(code); } }

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
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null) as TokenResponse | null;
  if (!response.ok || !data?.access_token || !data.refresh_token) throw new PaymentConnectionError(response.status >= 400 && response.status < 500 ? "provider_rejected" : "provider_error");
  return data;
}

export async function beginMercadoPagoOAuth(establishmentId: string): Promise<{ authorizationUrl: string }> {
  const { clientId, redirectUri } = config();
  const state = randomUUID(); const codeVerifier = verifier(); const now = Date.now();
  const record: OAuthState = { id: state, establishmentId, provider: PROVIDER, verifier: encryptPaymentConnectionSecret(codeVerifier), expiresAt: now + STATE_TTL_MS, consumedAt: null, createdAt: now };
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
  const now = Date.now(); const connection: PaymentConnection = { id: PROVIDER, establishmentId: attempt.establishmentId, provider: PROVIDER, status: "connected", providerAccountId: token.user_id == null ? null : String(token.user_id), scopes: token.scope?.split(" ").filter(Boolean) ?? ["offline_access"], connectedAt: now, disconnectedAt: null, expiresAt: typeof token.expires_in === "number" ? now + token.expires_in * 1000 : null, createdAt: now, updatedAt: now };
  const credentials: PaymentConnectionCredentials = { connectionId: PROVIDER, accessToken: encryptPaymentConnectionSecret(token.access_token), refreshToken: encryptPaymentConnectionSecret(token.refresh_token), updatedAt: now };
  await db.runTransaction(async (tx) => { tx.set(connectionRef(attempt.establishmentId), connection, { merge: true }); tx.set(credentialsRef(attempt.establishmentId), credentials); });
}

export async function getMercadoPagoConnection(establishmentId: string): Promise<PaymentConnection | null> { const snap = await connectionRef(establishmentId).get(); return snap.exists ? snap.data() as PaymentConnection : null; }
export async function disconnectMercadoPago(establishmentId: string): Promise<void> { const ref = connectionRef(establishmentId); await db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new PaymentConnectionError("not_found"); tx.update(ref, { status: "disconnected", disconnectedAt: Date.now(), updatedAt: Date.now(), refreshLeaseId: null, refreshLeaseExpiresAt: null }); tx.delete(credentialsRef(establishmentId)); }); }

export async function refreshMercadoPagoConnection(establishmentId: string): Promise<PaymentConnection> {
  const leaseId = randomUUID(); const ref = connectionRef(establishmentId); const secretRef = credentialsRef(establishmentId);
  const claimed = await db.runTransaction(async (tx) => { const [connectionSnap, secretSnap] = await Promise.all([tx.get(ref), tx.get(secretRef)]); if (!connectionSnap.exists || !secretSnap.exists) throw new PaymentConnectionError("not_found"); const connection = connectionSnap.data() as PaymentConnection; if (connection.status !== "connected") throw new PaymentConnectionError("not_connected"); if ((connection.refreshLeaseExpiresAt ?? 0) > Date.now()) throw new PaymentConnectionError("refresh_in_progress"); tx.update(ref, { refreshLeaseId: leaseId, refreshLeaseExpiresAt: Date.now() + REFRESH_LEASE_MS, updatedAt: Date.now() }); return secretSnap.data() as PaymentConnectionCredentials; });
  const { clientId, clientSecret } = config(); let token: TokenResponse;
  try { token = await exchange({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: decryptPaymentConnectionSecret(claimed.refreshToken) }); } catch (error) { await db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (snap.exists && (snap.data() as PaymentConnection).refreshLeaseId === leaseId) tx.update(ref, { status: error instanceof PaymentConnectionError && error.code === "provider_rejected" ? "requires_reauth" : "connected", refreshLeaseId: null, refreshLeaseExpiresAt: null, updatedAt: Date.now() }); }); throw error; }
  return db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists || (snap.data() as PaymentConnection).refreshLeaseId !== leaseId) throw new PaymentConnectionError("refresh_in_progress"); const now = Date.now(); const next: PaymentConnection = { ...(snap.data() as PaymentConnection), status: "connected", providerAccountId: token.user_id == null ? (snap.data() as PaymentConnection).providerAccountId : String(token.user_id), scopes: token.scope?.split(" ").filter(Boolean) ?? (snap.data() as PaymentConnection).scopes, expiresAt: typeof token.expires_in === "number" ? now + token.expires_in * 1000 : null, refreshLeaseId: undefined, refreshLeaseExpiresAt: undefined, updatedAt: now }; tx.set(ref, next); tx.set(secretRef, { connectionId: PROVIDER, accessToken: encryptPaymentConnectionSecret(token.access_token), refreshToken: encryptPaymentConnectionSecret(token.refresh_token), updatedAt: now }); return next; });
}

// Invariável para F12-D+: webhook de sucesso de uma PaymentAttempt superseded
// nunca pode marcar o Payment atual como paid; deve registrar divergência e
// entrar em reconciliation dentro da mesma transação.
