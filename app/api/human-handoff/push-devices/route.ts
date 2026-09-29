// POST   /api/human-handoff/push-devices { token } -> registra este aparelho
// DELETE /api/human-handoff/push-devices { token } -> remove este aparelho
// O token FCM fica sob o estabelecimento da sessão; nunca vem de outro tenant.
import { NextRequest, NextResponse } from "next/server";
import { resolvePanelActor } from "@/lib/auth/session";
import { registerPushDevice, unregisterPushDevice } from "@/lib/humanHandoff/push";

export const dynamic = "force-dynamic";

async function readToken(req: NextRequest): Promise<string | null> {
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  return token.length >= 20 && token.length <= 4096 ? token : null;
}

export async function POST(req: NextRequest) {
  const actor = await resolvePanelActor(req);
  if (!actor) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const token = await readToken(req);
  if (!token) return NextResponse.json({ error: "token inválido" }, { status: 400 });
  const device = await registerPushDevice(actor.establishmentId, {
    token,
    uid: actor.uid,
    userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
  });
  return NextResponse.json({ ok: true, deviceId: device.id });
}

export async function DELETE(req: NextRequest) {
  const actor = await resolvePanelActor(req);
  if (!actor) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const token = await readToken(req);
  if (!token) return NextResponse.json({ error: "token inválido" }, { status: 400 });
  await unregisterPushDevice(actor.establishmentId, token);
  return NextResponse.json({ ok: true });
}
