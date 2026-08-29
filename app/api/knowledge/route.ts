// GET /api/knowledge  -> base de conhecimento do estabelecimento
// PUT /api/knowledge  -> salva a base de conhecimento
//
// Tenant resolvido por resolveEstablishmentId (dev: ?est= ou header;
// produção: token — TODO).
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getKnowledgeBase, saveKnowledgeBase } from "@/lib/repo";
import type { KnowledgeBase, KnowledgeService, KnowledgeFaq } from "@/types";

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  const kb = await getKnowledgeBase(id);
  return NextResponse.json({ knowledge: kb });
}

export async function PUT(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const raw = (await req.json().catch(() => null)) as Partial<KnowledgeBase> | null;
  if (!raw) return NextResponse.json({ error: "payload inválido" }, { status: 400 });

  // Sanitiza/normaliza a entrada (não confia no shape vindo do cliente).
  const services: KnowledgeService[] = Array.isArray(raw.services)
    ? raw.services
        .filter((s) => s && typeof s.name === "string" && s.name.trim())
        .map((s) => ({
          name: String(s.name).trim(),
          priceText: s.priceText ? String(s.priceText).trim() : null,
          durationText: s.durationText ? String(s.durationText).trim() : null,
          description: s.description ? String(s.description).trim() : null,
        }))
    : [];

  const faqs: KnowledgeFaq[] = Array.isArray(raw.faqs)
    ? raw.faqs
        .filter((f) => f && typeof f.question === "string" && f.question.trim())
        .map((f) => ({
          question: String(f.question).trim(),
          answer: String(f.answer ?? "").trim(),
        }))
    : [];

  const kb = await saveKnowledgeBase(id, {
    about: raw.about ? String(raw.about).trim() : "",
    address: raw.address ? String(raw.address).trim() : null,
    hours: raw.hours ? String(raw.hours).trim() : null,
    services,
    faqs,
    notes: raw.notes ? String(raw.notes).trim() : null,
  });

  return NextResponse.json({ knowledge: kb });
}
