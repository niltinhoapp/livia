import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { listMenuProducts, saveMenuProduct } from "@/lib/orders";
// Sem portão de `bot.ordersEnabled`: ver app/api/menu/categories/route.ts.
// Esta listagem é a do PAINEL e devolve tudo, inclusive produto desativado e
// produto de categoria desativada — o comerciante precisa enxergar para
// reativar. A visão filtrada do que pode ser vendido é
// listAvailableMenuProducts, usada só pelas ferramentas da IA.
export async function GET(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); return NextResponse.json({ products: await listMenuProducts(id) }); }
export async function POST(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); try { return NextResponse.json({ product: await saveMenuProduct(id, await req.json()) }); } catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }); } }
