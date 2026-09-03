// GET  /api/knowledge/corrections -> últimas correções aplicadas (auditoria)
// POST /api/knowledge/corrections -> aplica uma correção (Passo 8: "Ensinar
//      a Livia"). Body: { category, correctText, question?, conversationId? }
//
// A escrita real acontece em lib/repo.ts (applyKnowledgeCorrection), que só
// consegue tocar KnowledgeBase (faqs/notes) e o próprio log de correções —
// estruturalmente incapaz de alcançar Establishment, whatsapp, Appointment
// ou qualquer dado de integração.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { applyKnowledgeCorrection, listKnowledgeCorrections } from "@/lib/repo";
import type { CorrectionCategory } from "@/types";

const VALID_CATEGORIES: CorrectionCategory[] = [
  "faq",
  "establishment_info",
  "business_rule",
  "communication_preference",
  "operational_knowledge",
];

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const corrections = await listKnowledgeCorrections(id);
  return NextResponse.json({ corrections });
}

export async function POST(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const raw = (await req.json().catch(() => null)) as {
    category?: unknown;
    question?: unknown;
    correctText?: unknown;
    conversationId?: unknown;
  } | null;

  const category = raw?.category;
  const correctText = raw?.correctText;
  if (typeof category !== "string" || !VALID_CATEGORIES.includes(category as CorrectionCategory)) {
    return NextResponse.json({ error: "category inválida" }, { status: 400 });
  }
  if (typeof correctText !== "string" || !correctText.trim()) {
    return NextResponse.json({ error: "correctText é obrigatório" }, { status: 400 });
  }
  // FAQ exige a pergunta original — sem ela não há como saber se deve
  // substituir uma FAQ existente ou criar uma nova.
  const question = typeof raw?.question === "string" && raw.question.trim() ? raw.question.trim() : null;
  if (category === "faq" && !question) {
    return NextResponse.json({ error: "question é obrigatório para category=faq" }, { status: 400 });
  }

  const correction = await applyKnowledgeCorrection(id, {
    category: category as CorrectionCategory,
    question,
    correctText: correctText.trim(),
    conversationId: typeof raw?.conversationId === "string" ? raw.conversationId : null,
  });
  return NextResponse.json({ correction });
}
