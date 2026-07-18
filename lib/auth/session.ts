// Resolve o estabelecimento (establishmentId) a partir da requisição.
// Em produção: validar um session token (JWT) — TODO quando o painel tiver
// login. Em dev/MVP: aceita o header x-establishment-id (ou ?est= na query).
import type { NextRequest } from "next/server";

export function resolveEstablishmentId(req: NextRequest): string | null {
  // TODO(produção/segurança): trocar por validação de session token (JWT) do
  // login. Enquanto NÃO há login, o tenant vem do header x-establishment-id
  // ou do parametro ?est= — inclusive em produção, só pra permitir testar os
  // painéis. ISSO É INSEGURO (qualquer um acessa qualquer est) e deve sair
  // assim que o login existir.
  const header = req.headers.get("x-establishment-id");
  if (header) return header;
  return req.nextUrl.searchParams.get("est");
}
