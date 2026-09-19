import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { listMenuCategories, saveMenuCategory } from "@/lib/orders";
// Sem portão de `bot.ordersEnabled`: cadastrar cardápio é preparação do
// comerciante, não comportamento da IA. Ver app/api/orders/route.ts.
export async function GET(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); return NextResponse.json({ categories: await listMenuCategories(id) }); }
export async function POST(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); try { return NextResponse.json({ category: await saveMenuCategory(id, await req.json()) }); } catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }); } }
