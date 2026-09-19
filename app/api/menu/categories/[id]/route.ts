import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { saveMenuCategory } from "@/lib/orders";
import { ordersEnabledFor } from "@/lib/ordersAccess";
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { const est = await resolveEstablishmentId(req); const { id } = await params; if (!est) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); if (!await ordersEnabledFor(est)) return NextResponse.json({ error: "pedidos desabilitados" }, { status: 404 }); try { return NextResponse.json({ category: await saveMenuCategory(est, await req.json(), id) }); } catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }); } }
