import { beforeEach, describe, expect, it, vi } from "vitest";

const { randomUuid } = vi.hoisted(() => ({ randomUuid: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:crypto")>()), randomUUID: randomUuid }));
vi.mock("@/lib/firebase/admin", async () => { const fake = await import("@/lib/__testing__/firestoreFake"); return { db: fake.fakeDb, sub: fake.sub }; });
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { beginMercadoPagoOAuth, completeMercadoPagoOAuth, disconnectMercadoPago, getMercadoPagoConnection, PaymentConnectionError, refreshMercadoPagoConnection } from "@/lib/payments/mercadoPagoOAuth";

const EST = "est-a"; const OTHER = "est-b";
const key = Buffer.from("01234567890123456789012345678901").toString("base64");
function tokenResponse(user = "merchant-a") { return { access_token: "access-value", refresh_token: "refresh-value", expires_in: 3600, user_id: user, scope: "offline_access" }; }
async function stateFromStart(establishmentId = EST) { const { authorizationUrl } = await beginMercadoPagoOAuth(establishmentId); return new URL(authorizationUrl).searchParams.get("state")!; }

beforeEach(() => { fakeDb.reset(); vi.restoreAllMocks(); let serial = 0; randomUuid.mockImplementation(() => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`); process.env.PAYMENT_CONNECTION_TOKEN_ENC_KEY = key; process.env.MERCADO_PAGO_CLIENT_ID = "app-id"; process.env.MERCADO_PAGO_CLIENT_SECRET = "app-secret"; process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI = "http://localhost:3000/api/payments/connections/mercado-pago/callback"; });

describe("Mercado Pago OAuth connection", () => {
  it("cria state opaco único e PKCE S256", async () => {
    const first = await beginMercadoPagoOAuth(EST); const second = await beginMercadoPagoOAuth(EST);
    const url = new URL(first.authorizationUrl);
    expect(url.searchParams.get("state")).toHaveLength(36); expect(url.searchParams.get("code_challenge_method")).toBe("S256"); expect(url.searchParams.get("state")).not.toBe(new URL(second.authorizationUrl).searchParams.get("state"));
    expect(first.authorizationUrl).not.toContain(EST);
  });

  it("falha ao criar state novo não deixa geração fantasma nem invalida OAuth anterior", async () => {
    const previousState = await stateFromStart();
    const collidingState = "00000000-0000-4000-8000-000000000002";
    await fakeDb.collection("_paymentOAuthStates").doc(collidingState).create({ id: collidingState });
    await expect(beginMercadoPagoOAuth(EST)).rejects.toMatchObject({ code: 6 });
    expect(await getMercadoPagoConnection(EST)).toMatchObject({ status: "pending", oauthGeneration: 1 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tokenResponse("authoritative-account")), { status: 200 })));
    await completeMercadoPagoOAuth("previous-code", previousState);
    expect(await getMercadoPagoConnection(EST)).toMatchObject({ status: "connected", oauthGeneration: 1, providerAccountId: "authoritative-account" });
  });

  it("consome state uma vez e cria metadata + credenciais cifradas no tenant correto", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tokenResponse()), { status: 200 })));
    const state = await stateFromStart(); await completeMercadoPagoOAuth("short-code", state);
    expect(await getMercadoPagoConnection(EST)).toMatchObject({ status: "connected", providerAccountId: "merchant-a", provider: "mercado_pago" });
    expect(await getMercadoPagoConnection(OTHER)).toBeNull();
    const secret = await fakeDb.collection(`establishments/${EST}/paymentConnectionSecrets`).doc("mercado_pago").get();
    expect(JSON.stringify(secret.data())).not.toContain("access-value"); expect(JSON.stringify(secret.data())).not.toContain("refresh-value");
    await expect(completeMercadoPagoOAuth("short-code", state)).rejects.toMatchObject({ code: "used_state" });
  });

  it("rejeita state inválido, expirado e protege callback de cross-tenant", async () => {
    await expect(completeMercadoPagoOAuth("code", "not-a-state")).rejects.toMatchObject({ code: "invalid_state" });
    const state = await stateFromStart(EST); await fakeDb.collection("_paymentOAuthStates").doc(state).update({ expiresAt: 0 });
    await expect(completeMercadoPagoOAuth("code", state)).rejects.toMatchObject({ code: "expired_state" });
  });

  it("refresh rota tokens atomicamente e somente uma concorrência alcança o provider", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tokenResponse()), { status: 200 })));
    await completeMercadoPagoOAuth("code", await stateFromStart());
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(tokenResponse()), { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.allSettled([refreshMercadoPagoConnection(EST), refreshMercadoPagoConnection(EST)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getMercadoPagoConnection(EST)).toMatchObject({ status: "connected" });
  });

  it("refresh antigo não sobrescreve reconexão OAuth de geração nova", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tokenResponse("old-account")), { status: 200 })));
    await completeMercadoPagoOAuth("initial", await stateFromStart());
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const refreshStartedPromise = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const refreshResponse = new Promise<Response>((resolve) => { releaseRefresh = () => resolve(new Response(JSON.stringify(tokenResponse("old-account")), { status: 200 })); });
    const fetchMock = vi.fn().mockImplementationOnce(() => { refreshStarted(); return refreshResponse; }).mockResolvedValueOnce(new Response(JSON.stringify(tokenResponse("new-account")), { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    const refresh = refreshMercadoPagoConnection(EST);
    await refreshStartedPromise;
    const reconnectState = await stateFromStart();
    await completeMercadoPagoOAuth("reconnect", reconnectState);
    releaseRefresh();
    await expect(refresh).rejects.toMatchObject({ code: "refresh_in_progress" });
    expect(await getMercadoPagoConnection(EST)).toMatchObject({ status: "connected", providerAccountId: "new-account", oauthGeneration: 2 });
  });

  it("callback OAuth iniciado antes não sobrescreve autorização mais recente", async () => {
    const older = await stateFromStart(); const newer = await stateFromStart();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(tokenResponse("new-account")), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(tokenResponse("old-account")), { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    await completeMercadoPagoOAuth("new-code", newer);
    await expect(completeMercadoPagoOAuth("old-code", older)).rejects.toMatchObject({ code: "superseded_state" });
    expect(await getMercadoPagoConnection(EST)).toMatchObject({ providerAccountId: "new-account", oauthGeneration: 2 });
  });

  it("429 e timeout liberam lease sem exigir reautorização", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tokenResponse()), { status: 200 })));
    await completeMercadoPagoOAuth("code", await stateFromStart());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "local_rate_limited" }), { status: 429 })));
    await expect(refreshMercadoPagoConnection(EST)).rejects.toMatchObject({ code: "provider_error" });
    expect(await getMercadoPagoConnection(EST)).toMatchObject({ status: "connected", refreshLeaseId: null });
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))));
    const timeout = refreshMercadoPagoConnection(EST); const timeoutExpectation = expect(timeout).rejects.toMatchObject({ code: "provider_timeout" }); await vi.advanceTimersByTimeAsync(10_000);
    await timeoutExpectation;
    expect(await getMercadoPagoConnection(EST)).toMatchObject({ status: "connected", refreshLeaseId: null });
    vi.useRealTimers();
  });

  it("falha de refresh exige reautorização e disconnect preserva metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tokenResponse()), { status: 200 })));
    await completeMercadoPagoOAuth("code", await stateFromStart());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })));
    await expect(refreshMercadoPagoConnection(EST)).rejects.toBeInstanceOf(PaymentConnectionError);
    expect(await getMercadoPagoConnection(EST)).toMatchObject({ status: "requires_reauth" });
    await disconnectMercadoPago(EST); expect(await getMercadoPagoConnection(EST)).toMatchObject({ status: "disconnected", providerAccountId: "merchant-a" });
    expect((await fakeDb.collection(`establishments/${EST}/paymentConnectionSecrets`).doc("mercado_pago").get()).exists).toBe(false);
  });
});
