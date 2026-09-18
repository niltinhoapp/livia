import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment } from "@/lib/repo";
import { listMessageTemplates, WhatsAppTemplateError } from "@/lib/whatsapp/client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const establishment = await getEstablishment(establishmentId);
  if (!establishment?.whatsapp) return NextResponse.json({ error: "WhatsApp não conectado" }, { status: 409 });
  try {
    const templates = await listMessageTemplates(establishment.whatsapp, establishmentId);
    return NextResponse.json({ templates });
  } catch (error) {
    if (error instanceof WhatsAppTemplateError) {
      const status = error.code === "not_connected" || error.code === "missing_waba" ? 409 : 502;
      return NextResponse.json({ error: "não foi possível consultar os templates" }, { status });
    }
    console.error("[campaigns/templates] consulta falhou", { establishmentId });
    return NextResponse.json({ error: "não foi possível consultar os templates" }, { status: 502 });
  }
}
