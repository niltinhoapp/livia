// Resolve o estabelecimento (establishmentId) a partir da requisição.
// Em produção: validar um session token (JWT) — TODO quando o painel tiver
// login. Em dev/MVP: aceita o header x-establishment-id (ou ?est= na query).
import type { NextRequest } from "next/server";

export function resolveEstablishmentId(req: NextRequest): string | null {
  // TODO(produção): validar Authorization: Bearer <jwt> e extrair o claim.
  const header = req.headers.get("x-establishment-id");
  if (header) return header;

  if (process.env.NODE_ENV !== "production") {
    return req.nextUrl.searchParams.get("est");
  }
  return null;
}
