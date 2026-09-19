import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getOrderSettings, saveOrderSettings } from "@/lib/orders";
import { ordersEnabledFor } from "@/lib/ordersAccess";
export async function GET(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); if (!await ordersEnabledFor(id)) return NextResponse.json({ error: "pedidos desabilitados" }, { status: 404 }); return NextResponse.json({ settings: await getOrderSettings(id) }); }
export async function PUT(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); if (!await ordersEnabledFor(id)) return NextResponse.json({ error: "pedidos desabilitados" }, { status: 404 }); try { return NextResponse.json({ settings: await saveOrderSettings(id, await req.json()) }); } catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }); } }
