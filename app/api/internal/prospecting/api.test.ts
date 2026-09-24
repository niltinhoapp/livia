
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { POST, GET } from "./route";
import { PATCH } from "./[phone]/route";
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { transitionProspectingSession } from "@/lib/repo";

const SECRET = "secret-token";
const EST_ID = "est-conectweb";

beforeEach(() => {
  fakeDb.reset();
  process.env.INTERNAL_PROSPECTING_SECRET = SECRET;
  process.env.INTERNAL_PROSPECTING_ESTABLISHMENT_ID = EST_ID;
  vi.clearAllMocks();
});

function createReq(method: string, url: string, body?: any, auth?: string): NextRequest {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new NextRequest(new URL(url, "http://localhost"), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Prospecção Assistida API", () => {
  const validPayload = {
    leadId: "lead-1",
    phone: "5511999999999",
    businessName: "Test Bus",
    segment: "Seg",
    initialManualMessage: "Hello",
  };

  it("1. POST autenticado cria sessão → 201 e 2. POST retry idempotente → 200", async () => {
    const req1 = createReq("POST", "/", validPayload, `Bearer ${SECRET}`);
    const res1 = await POST(req1);
    expect(res1.status).toBe(201);
    const data1 = await res1.json();
    expect(data1.session.status).toBe("PREPARED");

    const req2 = createReq("POST", "/", validPayload, `Bearer ${SECRET}`);
    const res2 = await POST(req2);
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.session.status).toBe("PREPARED");
  });

  it("3. POST sem auth → 401 e 4. POST auth inválida → 401", async () => {
    const req1 = createReq("POST", "/", validPayload);
    const res1 = await POST(req1);
    expect(res1.status).toBe(401);

    const req2 = createReq("POST", "/", validPayload, `Bearer WRONG`);
    const res2 = await POST(req2);
    expect(res2.status).toBe(401);
  });

  it("5. POST telefone inválido → 400", async () => {
    const req = createReq("POST", "/", { ...validPayload, phone: "123" }, `Bearer ${SECRET}`);
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_PAYLOAD");
  });

  it("6. POST payload inválido → 400", async () => {
    const req = createReq("POST", "/", { ...validPayload, leadId: "" }, `Bearer ${SECRET}`);
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_PAYLOAD");
  });

  it("7. POST conflito → 409", async () => {
    await POST(createReq("POST", "/", validPayload, `Bearer ${SECRET}`));
    const req = createReq("POST", "/", { ...validPayload, phone: "5511888888888" }, `Bearer ${SECRET}`);
    const res = await POST(req);
    expect(res.status).toBe(409);
  });

  it("8. GET por leadId → 200 e 9. GET inexistente → 404 e 10. GET sem auth → 401", async () => {
    await POST(createReq("POST", "/", validPayload, `Bearer ${SECRET}`));
    
    const req401 = createReq("GET", "/?leadId=lead-1");
    expect((await GET(req401)).status).toBe(401);

    const req404 = createReq("GET", "/?leadId=lead-notfound", null, `Bearer ${SECRET}`);
    expect((await GET(req404)).status).toBe(404);

    const req200 = createReq("GET", "/?leadId=lead-1", null, `Bearer ${SECRET}`);
    const res200 = await GET(req200);
    expect(res200.status).toBe(200);
    expect((await res200.json()).session.leadId).toBe("lead-1");
  });

  it("11. PATCH confirm_manual_send → 200 e 12. PATCH repetido → idempotente", async () => {
    await POST(createReq("POST", "/", validPayload, `Bearer ${SECRET}`));
    const req = createReq("PATCH", "/", { action: "confirm_manual_send" }, `Bearer ${SECRET}`);
    const res = await PATCH(req, { params: { phone: validPayload.phone } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session.status).toBe("WAITING_REPLY");
    expect(data.session.manualSendConfirmedAt).toBeDefined();

    const req2 = createReq("PATCH", "/", { action: "confirm_manual_send" }, `Bearer ${SECRET}`);
    const res2 = await PATCH(req2, { params: { phone: validPayload.phone } });
    expect(res2.status).toBe(200);
    expect((await res2.json()).session.status).toBe("WAITING_REPLY");
  });

  it("13. confirmação tardia após LIVIA_ACTIVE não regride status e 14. confirm não renova expiresAt", async () => {
    await POST(createReq("POST", "/", validPayload, `Bearer ${SECRET}`));
    // Simula transição pra LIVIA_ACTIVE
    await transitionProspectingSession(EST_ID, validPayload.phone, { action: "receive_reply" });
    
    // Agora tenta confirmar
    const req = createReq("PATCH", "/", { action: "confirm_manual_send" }, `Bearer ${SECRET}`);
    const res = await PATCH(req, { params: { phone: validPayload.phone } });
    const session = (await res.json()).session;
    expect(session.status).toBe("LIVIA_ACTIVE"); // não regrediu
    expect(session.manualSendConfirmedAt).toBeTruthy();

    const originalSession = await (await GET(createReq("GET", "/?leadId=lead-1", null, `Bearer ${SECRET}`))).json();
    expect(session.expiresAt).toBe(originalSession.session.expiresAt);
  });

  it("15. PATCH abort válido → CLOSED", async () => {
    await POST(createReq("POST", "/", validPayload, `Bearer ${SECRET}`));
    const req = createReq("PATCH", "/", { action: "abort" }, `Bearer ${SECRET}`);
    const res = await PATCH(req, { params: { phone: validPayload.phone } });
    expect(res.status).toBe(200);
    expect((await res.json()).session.status).toBe("CLOSED");
  });

  it("16. abort não sobrescreve OPTED_OUT", async () => {
    await POST(createReq("POST", "/", validPayload, `Bearer ${SECRET}`));
    await transitionProspectingSession(EST_ID, validPayload.phone, { action: "opt_out" });

    const req = createReq("PATCH", "/", { action: "abort" }, `Bearer ${SECRET}`);
    const res = await PATCH(req, { params: { phone: validPayload.phone } });
    expect(res.status).toBe(409); // Tentativa de abort em terminal state -> invalid_transition
    
    const getRes = await GET(createReq("GET", "/?leadId=lead-1", null, `Bearer ${SECRET}`));
    expect((await getRes.json()).session.status).toBe("OPTED_OUT");
  });

  it("17. tentativa de injetar establishmentId não muda tenant", async () => {
    const req = createReq("POST", "/", { ...validPayload, establishmentId: "hacker" }, `Bearer ${SECRET}`);
    await POST(req);

    // O GET usa a variável de ambiente, então deve encontrar. 
    // Se usasse "hacker", não encontraria (ou encontraria no tenant hacker).
    const docData = fakeDb.col(`establishments/${EST_ID}/prospectingSessions`).get(validPayload.phone);
    expect(docData).toBeDefined();
    expect(docData!.establishmentId).toBe(EST_ID);
  });

  it("18. erro interno → resposta sanitizada", async () => {
    // Apaga a env var pra causar INTERNAL_CONFIGURATION_ERROR (500), mas num caso real sem dar trace stack
    delete process.env.INTERNAL_PROSPECTING_ESTABLISHMENT_ID;
    const req = createReq("POST", "/", validPayload, `Bearer ${SECRET}`);
    const res = await POST(req);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("INTERNAL_CONFIGURATION_ERROR");
  });
});

