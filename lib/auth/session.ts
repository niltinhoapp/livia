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
import { defaultBotConfig, initialTrialBilling } from "@/lib/repo";
import type { Establishment } from "@/types";

export const SESSION_COOKIE_NAME = "livia_session";
export const SESSION_MAX_AGE_MS = 14 * 24 * 3600000; // 14 dias
const PILOT_NEW_ACCOUNT_LIMIT = 10;
const PILOT_COUNTER_PATH = ["_system", "pilot-access-v1"] as const;

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
  if (snap.empty) {
    // Contas que já tinham establishment continuam fora desta contagem. Para
    // contas realmente novas, reserva uma das 10 vagas do piloto de forma
    // transacional e cria o tenant no mesmo commit. Assim duas primeiras
    // entradas simultâneas não conseguem consumir a mesma vaga.
    const admitted = await db.runTransaction(async (tx) => {
      const existing = await tx.get(
        db.collection("establishments").where("ownerUid", "==", uid).limit(1),
      );
      if (!existing.empty) return existing.docs[0]!.id;

      const tenantRef = db.collection("establishments").doc(uid);
      const counterRef = db.collection(PILOT_COUNTER_PATH[0]).doc(PILOT_COUNTER_PATH[1]);
      const [tenantSnap, counterSnap] = await Promise.all([
        tx.get(tenantRef),
        tx.get(counterRef),
      ]);

      // Nunca sobrescreve um documento determinístico que pertença a outro
      // usuário. Esse caso falha fechado.
      if (tenantSnap.exists) {
        const persisted = tenantSnap.data() as Establishment;
        return persisted.ownerUid === uid ? tenantRef.id : null;
      }

      const used = counterSnap.exists
        ? Number((counterSnap.data() as { admitted?: unknown }).admitted ?? 0)
        : 0;
      if (!Number.isInteger(used) || used < 0 || used >= PILOT_NEW_ACCOUNT_LIMIT) return null;

      const now = Date.now();
      const created: Establishment = {
        id: uid,
        name: "",
        type: "outro",
        ownerUid: uid,
        status: "active",
        createdAt: now,
        billing: initialTrialBilling(now),
        panelAccess: "allowed",
        bot: defaultBotConfig(),
      };
      tx.create(tenantRef, created);
      if (counterSnap.exists) {
        tx.update(counterRef, { admitted: used + 1, updatedAt: now });
      } else {
        tx.create(counterRef, { admitted: 1, limit: PILOT_NEW_ACCOUNT_LIMIT, createdAt: now, updatedAt: now });
      }
      return tenantRef.id;
    });

    if (!admitted) return { status: "blocked" };
    return { status: "allowed", establishmentId: admitted, legacy: false };
  }

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
