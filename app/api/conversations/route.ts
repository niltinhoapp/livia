// GET /api/conversations -> lista as conversas do estabelecimento (mais
// recentes primeiro), pra tela /painel/conversas.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { listConversations } from "@/lib/repo";

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const conversations = await listConversations(id);
  return NextResponse.json({ conversations });
}
