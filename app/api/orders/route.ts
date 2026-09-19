import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { listOrders } from "@/lib/orders";
import { ordersEnabledFor } from "@/lib/ordersAccess";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); if (!await ordersEnabledFor(id)) return NextResponse.json({ error: "pedidos desabilitados" }, { status: 404 }); return NextResponse.json({ orders: await listOrders(id) }); }
