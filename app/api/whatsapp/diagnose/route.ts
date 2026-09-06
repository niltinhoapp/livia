// DIAGNÓSTICO TEMPORÁRIO (06/09/2026): caso aberto com o suporte da Meta —
// mensagens do cliente chegam via um número/WABA diferente do que a Livia
// tem conectado (ver logStage "meta case 131047" em
// app/api/webhooks/whatsapp/route.ts). Suspeita: a inscrição de webhooks da
// WABA real (subscribeAppToWaba, feita no passo 4 de /api/whatsapp/connect)
// nunca "pegou" de fato, ou foi perdida depois (ex.: coexistência com o app
// oficial do WhatsApp Business reconfigurando a WABA).
//
// GET  -> lista os apps de fato inscritos na WABA do estabelecimento logado.
// POST -> re-inscreve o app da Livia (idempotente — mesma chamada do connect).
//
// Tenant sempre via resolveEstablishmentId(req) (sessão), nunca do corpo.
// Nunca loga/devolve o access token — só o resultado da consulta à Meta.
// Remover esta rota depois que a causa raiz for confirmada e corrigida.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment } from "@/lib/repo";
import { getSubscribedApps, subscribeAppToWaba, graphErrorOf } from "@/lib/whatsapp/embedded";
import { decryptToken } from "@/lib/whatsapp/tokenCrypto";

async function loadConnectedWaba(req: NextRequest): Promise<
  { error: NextResponse } | { wabaId: string; phoneNumberId: string; token: string }
> {
  const id = await resolveEstablishmentId(req);
  if (!id) return { error: NextResponse.json({ error: "não autenticado" }, { status: 401 }) };

  const est = await getEstablishment(id);
  const wa = est?.whatsapp;
  if (!wa || wa.status !== "connected" || !wa.accessToken) {
    return { error: NextResponse.json({ error: "WhatsApp não conectado" }, { status: 400 }) };
  }
  return { wabaId: wa.wabaId, phoneNumberId: wa.phoneNumberId, token: decryptToken(wa.accessToken) };
}

export async function GET(req: NextRequest) {
  const loaded = await loadConnectedWaba(req);
  if ("error" in loaded) return loaded.error;

  try {
    const subscribedAppIds = await getSubscribedApps(loaded.wabaId, loaded.token);
    const ourAppId = process.env.NEXT_PUBLIC_META_APP_ID ?? null;
    return NextResponse.json({
      wabaId: loaded.wabaId,
      phoneNumberId: loaded.phoneNumberId,
      ourAppId,
      subscribedAppIds,
      isSubscribed: ourAppId !== null && subscribedAppIds.includes(ourAppId),
    });
  } catch (err) {
    return NextResponse.json({ error: "GET_SUBSCRIBED_FAILED", graph: graphErrorOf(err) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const loaded = await loadConnectedWaba(req);
  if ("error" in loaded) return loaded.error;

  try {
    await subscribeAppToWaba(loaded.wabaId, loaded.token);
    return NextResponse.json({ resubscribed: true, wabaId: loaded.wabaId });
  } catch (err) {
    return NextResponse.json({ error: "SUBSCRIBE_FAILED", graph: graphErrorOf(err) }, { status: 502 });
  }
}
