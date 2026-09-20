import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getOrder, transitionOrder } from "@/lib/orders";
import type { OrderStatus } from "@/types";
// Sem portão de `bot.ordersEnabled`: ver comentário em app/api/orders/route.ts.
// Ver e avançar o status de um pedido que já existe é gestão do comerciante,
// não comportamento da IA. O escopo por estabelecimento (resolveEstablishmentId)
// continua sendo a trava de acesso.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { const est = await resolveEstablishmentId(req); const { id } = await params; if (!est) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); const order = await getOrder(est, id); return order ? NextResponse.json({ order }) : NextResponse.json({ error: "pedido não encontrado" }, { status: 404 }); }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { const est = await resolveEstablishmentId(req); const { id } = await params; if (!est) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); try { const body = await req.json() as { status?: OrderStatus }; if (!body.status) throw new Error("status obrigatório"); return NextResponse.json({ order: await transitionOrder(est, id, body.status) }); } catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }); } }
