// GET   /api/conversations/:id -> conversa + mensagens (ordem cronológica)
// PATCH /api/conversations/:id -> { action: "assume" | "return" }
//   "assume" -> um atendente assume: status vira "human", a Livia para de
//               responder automaticamente pra esse contato.
//   "return" -> devolve pra Livia: status volta a "bot".
//
// O isolamento por tenant é implícito: a conversa é lida/gravada sempre
// dentro de establishments/{id}/conversations/{conversationId}, com `id`
// vindo exclusivamente de resolveEstablishmentId(req) — nunca do payload.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getConversation, listMessages, setConversationStatus } from "@/lib/repo";

// Mesmo motivo de app/api/conversations/route.ts: força no-store explícito
// pra garantir que status/histórico nunca sejam servidos de um cache.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const conversation = await getConversation(id, params.id);
  if (!conversation) return NextResponse.json({ error: "conversa não encontrada" }, { status: 404 });

  const messages = await listMessages(id, params.id);
  return NextResponse.json({ conversation, messages });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const conversation = await getConversation(id, params.id);
  if (!conversation) return NextResponse.json({ error: "conversa não encontrada" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  if (body?.action === "assume") {
    await setConversationStatus(id, params.id, "human");
    return NextResponse.json({ ok: true, status: "human" });
  }
  if (body?.action === "return") {
    await setConversationStatus(id, params.id, "bot");
    return NextResponse.json({ ok: true, status: "bot" });
  }
  return NextResponse.json({ error: "action inválida (use 'assume' ou 'return')" }, { status: 400 });
}
