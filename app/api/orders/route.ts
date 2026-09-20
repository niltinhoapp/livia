import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { listOrders } from "@/lib/orders";
import { ordersEnabledFor } from "@/lib/ordersAccess";
export const dynamic = "force-dynamic";
// `bot.ordersEnabled` controla o que a IA faz — se ela aceita pedido novo na
// conversa. NÃO controla o que o comerciante enxerga: desligar o interruptor
// no meio do expediente escondia do painel os pedidos já confirmados, em
// preparo ou saindo pra entrega, travando a operação do dia. O estado do
// interruptor vai junto na resposta para a tela poder avisar que a IA está
// fora do ar, sem bloquear a gestão.
export async function GET(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); return NextResponse.json({ orders: await listOrders(id), ordersEnabled: await ordersEnabledFor(id) }); }
