// POST /api/conversations/:id/messages { text, clientMessageId }
// Resposta do atendente humano, somente com a conversa assumida. O tenant vem
// da sessão; a conversa é sempre lida dentro dele.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { sendAgentReply } from "@/lib/humanHandoff/agentReply";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: conversationId } = await params;
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { text?: unknown; clientMessageId?: unknown } | null;
  const result = await sendAgentReply({ establishmentId, conversationId, text: body?.text, clientMessageId: body?.clientMessageId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, messageId: result.messageId, duplicate: result.duplicate });
}
