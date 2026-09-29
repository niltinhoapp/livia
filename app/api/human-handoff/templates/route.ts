// GET /api/human-handoff/templates -> templates aprovados da WABA deste
// estabelecimento que o aviso de atendimento humano consegue preencher.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment } from "@/lib/repo";
import { listHandoffTemplateOptions } from "@/lib/humanHandoff/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const establishment = await getEstablishment(establishmentId);
  if (establishment?.whatsapp?.status !== "connected") return NextResponse.json({ error: "WhatsApp não conectado" }, { status: 409 });
  try {
    return NextResponse.json({ templates: await listHandoffTemplateOptions(establishment) });
  } catch {
    return NextResponse.json({ error: "não foi possível consultar os templates" }, { status: 502 });
  }
}
