// POST /api/customers/import — fundação para entrada explícita de contatos
// com opt-in. Tenant vem exclusivamente da sessão; establishmentId no corpo
// é ignorado e nunca chega ao repositório.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { importMarketingContacts } from "@/lib/repo";
import type { MarketingImportContact, MarketingImportDeclaration } from "@/types";

export const dynamic = "force-dynamic";

function parseBody(value: unknown): { contacts: MarketingImportContact[]; declaration: MarketingImportDeclaration } | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { contacts?: unknown; declaration?: unknown };
  if (!Array.isArray(body.contacts) || !body.declaration || typeof body.declaration !== "object") return null;
  return {
    contacts: body.contacts as MarketingImportContact[],
    declaration: body.declaration as MarketingImportDeclaration,
  };
}

export async function POST(req: NextRequest) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const parsed = parseBody(await req.json().catch(() => null));
  if (!parsed) return NextResponse.json({ error: "importação inválida" }, { status: 400 });

  try {
    const result = await importMarketingContacts(establishmentId, parsed);
    return NextResponse.json({ result });
  } catch (err) {
    // Todas as mensagens lançadas pelo domínio são validações deliberadamente
    // seguras para o painel; erros de infraestrutura não expõem detalhes.
    if (err instanceof Error && /importação|telefone|nome|declaração/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "não foi possível importar contatos" }, { status: 500 });
  }
}
