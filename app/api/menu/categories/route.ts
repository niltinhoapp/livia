import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { listMenuCategories, saveMenuCategory } from "@/lib/orders";
import { ordersEnabledFor } from "@/lib/ordersAccess";
export async function GET(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); if (!await ordersEnabledFor(id)) return NextResponse.json({ error: "pedidos desabilitados" }, { status: 404 }); return NextResponse.json({ categories: await listMenuCategories(id) }); }
export async function POST(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); if (!await ordersEnabledFor(id)) return NextResponse.json({ error: "pedidos desabilitados" }, { status: 404 }); try { return NextResponse.json({ category: await saveMenuCategory(id, await req.json()) }); } catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }); } }
