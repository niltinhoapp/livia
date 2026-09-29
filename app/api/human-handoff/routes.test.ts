import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb, firebaseAdminApp: {} };
});
let actor: { establishmentId: string; uid: string } | null = null;
vi.mock("@/lib/auth/session", () => ({
  resolveEstablishmentId: vi.fn(async () => actor?.establishmentId ?? null),
  resolvePanelActor: vi.fn(async () => actor),
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
const devices = await import("./push-devices/route");
const settings = await import("./settings/route");

const TOKEN = "fcm-token-do-celular-do-responsavel-000";
const json = (method: string, body: unknown) => new Request("https://livia.test/api/human-handoff", { method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }), headers: { "user-agent": "Mobile Safari" } }) as never;

beforeEach(() => {
  fakeDb.reset();
  actor = { establishmentId: "est-a", uid: "owner-a" };
  fakeDb.col("establishments").set("est-a", { id: "est-a" });
});

describe("rotas de atendimento humano do painel", () => {
  it("L: sem sessão do responsável, nada é lido nem gravado", async () => {
    actor = null;
    expect((await devices.POST(json("POST", { token: TOKEN }))).status).toBe(401);
    expect((await settings.PUT(json("PUT", { push: true }))).status).toBe(401);
    expect((await settings.GET(json("GET", {}))).status).toBe(401);
    expect(fakeDb.col("establishments/est-a/pushDevices").size).toBe(0);
  });

  it("P: o aparelho é registrado sob o estabelecimento da sessão e pode ser removido", async () => {
    expect((await devices.POST(json("POST", { token: TOKEN }))).status).toBe(200);
    expect([...fakeDb.col("establishments/est-a/pushDevices").values()]).toEqual([expect.objectContaining({ token: TOKEN, uid: "owner-a", userAgent: "Mobile Safari" })]);
    expect(fakeDb.col("establishments/est-b/pushDevices").size).toBe(0);
    await devices.POST(json("POST", { token: TOKEN }));
    expect(fakeDb.col("establishments/est-a/pushDevices").size).toBe(1);
    await devices.DELETE(json("DELETE", { token: TOKEN }));
    expect(fakeDb.col("establishments/est-a/pushDevices").size).toBe(0);
  });

  it("token inválido é recusado", async () => {
    expect((await devices.POST(json("POST", { token: "curto" }))).status).toBe(400);
  });

  it("configuração só de push é salva e lida de volta com a contagem de aparelhos", async () => {
    await devices.POST(json("POST", { token: TOKEN }));
    expect((await settings.PUT(json("PUT", { push: true, whatsapp: false }))).status).toBe(200);
    const body = await (await settings.GET(json("GET", {}))).json();
    expect(body).toMatchObject({ config: { push: true, whatsapp: false }, pushDevices: 1, whatsappConnected: false });
  });
});
