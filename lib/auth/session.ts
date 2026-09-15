// Sessão do painel: cookie httpOnly assinado pelo Firebase, criado em
// /api/auth/session a partir do ID token (Google ou e-mail/senha) do login.
//
// O establishmentId NUNCA vem do cliente (query/header) — é derivado do uid
// autenticado, via o campo Establishment.ownerUid (não da igualdade
// establishmentId === uid). Autenticação não concede acesso ao produto: só
// um estabelecimento vinculado e não bloqueado por panelAccess pode usar as
// rotas privadas. Estabelecimentos anteriores a este controle (sem o campo)
// continuam autorizados de modo compatível; uma conta nova sem documento
// vinculado não recebe um establishment candidato automaticamente.
import type { NextRequest } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { firebaseAdminApp, db } from "@/lib/firebase/admin";
import type { Establishment } from "@/types";

export const SESSION_COOKIE_NAME = "livia_session";
export const SESSION_MAX_AGE_MS = 14 * 24 * 3600000; // 14 dias

export type PanelAccessResolution =
  | { status: "unauthenticated" }
  | { status: "blocked" }
  | { status: "allowed"; establishmentId: string; legacy: boolean };

// Esta é a fronteira central de autorização do painel. Os handlers privados
// continuam chamando resolveEstablishmentId, que só expõe o tenant após esta
// decisão server-side; páginas usam a mesma resolução no layout.
export async function resolvePanelAccess(cookie: string | undefined): Promise<PanelAccessResolution> {
  if (!cookie) return { status: "unauthenticated" };

  let uid: string;
  try {
    const decoded = await getAuth(firebaseAdminApp).verifySessionCookie(cookie, true);
    uid = decoded.uid;
  } catch {
    return { status: "unauthenticated" }; // cookie expirado, revogado ou adulterado
  }

  const snap = await db
    .collection("establishments")
    .where("ownerUid", "==", uid)
    .limit(1)
    .get();
  if (snap.empty) return { status: "blocked" };

  const tenant = snap.docs[0]!.data() as Establishment;
  // Só os estados explicitamente permitidos e o legado sem campo entram. Um
  // valor inesperado em dados persistidos falha fechado.
  if (tenant.panelAccess !== undefined && tenant.panelAccess !== "allowed") {
    return { status: "blocked" };
  }

  return {
    status: "allowed",
    establishmentId: snap.docs[0]!.id,
    legacy: tenant.panelAccess === undefined,
  };
}

export async function resolveEstablishmentId(req: NextRequest): Promise<string | null> {
  const access = await resolvePanelAccess(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  return access.status === "allowed" ? access.establishmentId : null;
}
