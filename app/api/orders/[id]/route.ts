import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getOrder, isOperationalOrder, OrderOperationError, transitionOrder } from "@/lib/orders";
import type { OrderStatus } from "@/types";
// Sem portão de `bot.ordersEnabled`: ver comentário em app/api/orders/route.ts.
// Ver e avançar o status de um pedido que já existe é gestão do comerciante,
// não comportamento da IA. O escopo por estabelecimento (resolveEstablishmentId)
// continua sendo a trava de acesso.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { const est = await resolveEstablishmentId(req); const { id } = await params; if (!est) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); const order = await getOrder(est, id); return order && isOperationalOrder(order) ? NextResponse.json({ order }) : NextResponse.json({ error: "pedido não encontrado" }, { status: 404 }); }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const est = await resolveEstablishmentId(req); const { id } = await params;
  if (!est) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  try {
    const body = await req.json() as { status?: OrderStatus; expectedVersion?: number };
    if (!body.status) return NextResponse.json({ error: "status obrigatório" }, { status: 400 });
    if (!Number.isInteger(body.expectedVersion)) return NextResponse.json({ error: "versão esperada obrigatória" }, { status: 400 });
    return NextResponse.json({ order: await transitionOrder(est, id, body.status, body.expectedVersion!) });
  } catch (error) {
    if (error instanceof OrderOperationError) {
      const status = error.code === "not_found" ? 404 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "Não foi possível atualizar o pedido." }, { status: 400 });
  }
}
