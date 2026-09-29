// GET   /api/conversations/:id -> conversa + mensagens (ordem cronológica)
// PATCH /api/conversations/:id -> { action: "assume" | "return" }
//   "assume" -> um atendente assume: status vira "human", a Livia para de
//               responder automaticamente pra esse contato, por tempo
//               indeterminado.
//   "return" -> "Devolver para Lívia": status volta a "bot". Só esta ação faz isso.
//
// O isolamento por tenant é implícito: a conversa é lida/gravada sempre
// dentro de establishments/{id}/conversations/{conversationId}, com `id`
// vindo exclusivamente de resolveEstablishmentId(req) — nunca do payload.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId, resolvePanelActor } from "@/lib/auth/session";
import { getConversation, listMessages } from "@/lib/repo";
import { assumeConversation, returnConversationToBot } from "@/lib/humanHandoff/ownership";

// Mesmo motivo de app/api/conversations/route.ts: força no-store explícito
// pra garantir que status/histórico nunca sejam servidos de um cache.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: conversationId } = await params;
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const conversation = await getConversation(id, conversationId);
  if (!conversation) return NextResponse.json({ error: "conversa não encontrada" }, { status: 404 });

  const messages = await listMessages(id, conversationId);
  return NextResponse.json({ conversation, messages });
}

// Assumir e devolver são as ÚNICAS transições de posse humana. Ambas são
// transações condicionais (lib/humanHandoff/ownership.ts) com o autor da sessão
// registrado; repetir a mesma ação é idempotente. Não existe outro caminho
// human → bot: nem tempo, nem cron, nem mensagem do cliente.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: conversationId } = await params;
  const actor = await resolvePanelActor(req);
  if (!actor) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  if (body?.action !== "assume" && body?.action !== "return") {
    return NextResponse.json({ error: "action inválida (use 'assume' ou 'return')" }, { status: 400 });
  }
  const result = body.action === "assume"
    ? await assumeConversation(actor.establishmentId, conversationId, actor.uid)
    : await returnConversationToBot(actor.establishmentId, conversationId, actor.uid);
  if (!result.ok) {
    return result.error === "not_found"
      ? NextResponse.json({ error: "conversa não encontrada" }, { status: 404 })
      : NextResponse.json({ error: "esta conversa não pode ser devolvida no estado atual" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, status: result.status, changed: result.changed });
}
