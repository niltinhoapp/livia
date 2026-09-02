// POST /api/conversations/clear -> apaga todas as conversas (e mensagens) do
// estabelecimento atual. Usado pela ação "Limpar conversas" em
// /painel/conversas — hoje serve pra preparar o painel antes de gravações
// de demonstração (ex.: vídeo de revisão da Meta).
//
// Restrição de segurança: nesta primeira versão, só o tenant "demo"
// (Odonto) pode executar — qualquer outro estabelecimento recebe 403.
// O `id` vem exclusivamente de resolveEstablishmentId(req) (sessão), nunca
// do payload, então não há como um estabelecimento acionar isso para outro.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { clearConversations } from "@/lib/repo";

const ALLOWED_ESTABLISHMENT_ID = "demo";

export async function POST(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  if (id !== ALLOWED_ESTABLISHMENT_ID) {
    return NextResponse.json(
      { error: "ação indisponível para este estabelecimento" },
      { status: 403 },
    );
  }

  const result = await clearConversations(id);
  return NextResponse.json({ ok: true, ...result });
}
