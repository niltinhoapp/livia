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
import {
  getConversation,
  listMessages,
  setConversationStatus,
  resolvePendingTask,
  getPendingTask,
} from "@/lib/repo";

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
    // Passo 9: um humano assumindo resolve a pendência "aguardando
    // atendimento humano" (se havia uma) — é exatamente o que estava
    // pendente.
    await resolvePendingTask(id, params.id);
    return NextResponse.json({ ok: true, status: "human" });
  }
  if (body?.action === "return") {
    await setConversationStatus(id, params.id, "bot");
    // Devolver para a Livia encerra a pendência de atendimento humano — sem
    // isto, a conversa voltava para o bot mas continuava marcada como
    // "Precisa de humano" na caixa de entrada para sempre.
    //
    // Só a pendência de handoff é resolvida: uma pendência de outro tipo
    // (agendamento incompleto, reclamação) não foi atendida por esta ação e
    // não pode ser apagada junto.
    const pending = await getPendingTask(id, params.id);
    if (pending?.status === "open" && pending.type === "awaiting_human") {
      await resolvePendingTask(id, params.id);
    }
    return NextResponse.json({ ok: true, status: "bot" });
  }
  return NextResponse.json({ error: "action inválida (use 'assume' ou 'return')" }, { status: 400 });
}
