import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { requirePlatformAdmin } from "@/lib/auth/platformAdmin";
import { db } from "@/lib/firebase/admin";
import type { Establishment } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requirePlatformAdmin(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (auth.status === "unauthenticated") return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  if (auth.status !== "authorized") return NextResponse.json({ error: "acesso restrito" }, { status: 403 });

  const snap = await db.collection("establishments").orderBy("createdAt", "desc").limit(50).get();
  const establishments = await Promise.all(snap.docs.map(async (doc) => {
    const data = doc.data() as Establishment;
    const [campaigns, conversations] = await Promise.all([
      doc.ref.collection("campaigns").count().get(),
      doc.ref.collection("conversations").count().get(),
    ]);
    return {
      id: doc.id,
      name: data.name || "Sem nome",
      billingStatus: data.billing?.billingStatus ?? "legacy",
      whatsappStatus: data.whatsapp?.status ?? "not_connected",
      campaigns: campaigns.data().count,
      conversations: conversations.data().count,
      createdAt: (data as Establishment & { createdAt?: number }).createdAt ?? null,
    };
  }));

  return NextResponse.json({ establishments });
}
