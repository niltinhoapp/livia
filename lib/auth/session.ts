// Sessão do painel: cookie httpOnly assinado pelo Firebase, criado em
// /api/auth/session a partir do ID token (Google ou e-mail/senha) do login.
//
// O establishmentId NUNCA vem do cliente (query/header) — é derivado do uid
// autenticado, via o campo Establishment.ownerUid (não da igualdade
// establishmentId === uid). Isso permite vincular um uid a um estabelecimento
// já existente com id legado (ex.: "demo", criado antes da autenticação
// existir) sem precisar migrar/renomear nada. Se nenhum estabelecimento tem
// esse ownerUid ainda, o uid é usado como candidato de id para uma conta
// nova (o primeiro "Salvar" no painel cria o doc com ownerUid = uid, e a
// próxima busca por ownerUid já encontra esse mesmo doc).
import type { NextRequest } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { firebaseAdminApp, db } from "@/lib/firebase/admin";

export const SESSION_COOKIE_NAME = "livia_session";
export const SESSION_MAX_AGE_MS = 14 * 24 * 3600000; // 14 dias

export async function resolveEstablishmentId(req: NextRequest): Promise<string | null> {
  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) return null;

  let uid: string;
  try {
    const decoded = await getAuth(firebaseAdminApp).verifySessionCookie(cookie, true);
    uid = decoded.uid;
  } catch {
    return null; // cookie ausente, expirado, revogado ou adulterado
  }

  const snap = await db
    .collection("establishments")
    .where("ownerUid", "==", uid)
    .limit(1)
    .get();
  if (!snap.empty) return snap.docs[0]!.id;

  return uid; // nenhum estabelecimento vinculado ainda — candidato pra conta nova
}
