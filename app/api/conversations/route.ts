// GET /api/conversations -> lista as conversas do estabelecimento (mais
// recentes primeiro), pra tela /painel/conversas.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { listConversations } from "@/lib/repo";
import { classifyConversationsForInbox } from "@/lib/dashboard";

// Força dinâmico/no-store explicitamente: o tenant vem de req.cookies (não
// de cookies() do next/headers), então o Next não detecta automaticamente
// essa rota como dependente de sessão — sem isso, a resposta pode ser
// cacheada (CDN da Vercel ou navegador) e mostrar status desatualizado.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const conversations = await listConversations(id);
  // Passo 11: cada conversa ganha `inboxCategory`, derivada de dados já
  // existentes (status, PendingTask aberta, Opportunity) — não é uma rota
  // paralela, é a mesma listagem só anotada.
  const withInboxCategory = await classifyConversationsForInbox(id, conversations);
  return NextResponse.json({ conversations: withInboxCategory });
}
