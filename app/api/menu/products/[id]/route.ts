import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getMenuProduct, saveMenuProduct } from "@/lib/orders";
// Sem portão de `bot.ordersEnabled`: ver app/api/menu/categories/route.ts.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { const est = await resolveEstablishmentId(req); const { id } = await params; if (!est) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); const product = await getMenuProduct(est, id); return product ? NextResponse.json({ product }) : NextResponse.json({ error: "produto não encontrado" }, { status: 404 }); }
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { const est = await resolveEstablishmentId(req); const { id } = await params; if (!est) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); try { return NextResponse.json({ product: await saveMenuProduct(est, await req.json(), id) }); } catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }); } }
