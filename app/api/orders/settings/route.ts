import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getOrderSettings, saveOrderSettings } from "@/lib/orders";
import { getScheduleConfig } from "@/lib/scheduling";
// Sem portão de `bot.ordersEnabled`: configurar retirada/entrega, taxa e
// formas de pagamento é preparação do comerciante — precisa funcionar ANTES
// de ligar a IA, senão o fluxo "chegou, conectou, está pronto" exige ligar o
// atendimento sem ter o que configurar primeiro.
export async function GET(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); const [settings, schedule] = await Promise.all([getOrderSettings(id), getScheduleConfig(id)]); return NextResponse.json({ settings, schedule }); }
export async function PUT(req: NextRequest) { const id = await resolveEstablishmentId(req); if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); try { return NextResponse.json({ settings: await saveOrderSettings(id, await req.json()) }); } catch (e) { return NextResponse.json({ error: String(e) }, { status: 400 }); } }
