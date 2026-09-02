// POST /api/whatsapp/disconnect -> desconecta o WhatsApp do estabelecimento.
//
// Tenant SEMPRE via resolveEstablishmentId(req) (sessão) — nunca aceito do
// corpo da requisição.
//
// O que esta rota FAZ:
//   1. remove a inscrição de webhooks do app da Livia na WABA (para de
//      receber as mensagens de quem pediu para desconectar) — só quando
//      nenhum OUTRO estabelecimento conectado usa a mesma WABA, porque a
//      inscrição é por WABA e não por número;
//   2. limpa o estado de conexão no Firestore (ver disconnectWhatsapp).
//
// O que esta rota NÃO FAZ, deliberadamente:
//   - deregister do número na Meta: desconectar da Livia não pode desmontar a
//     configuração de WhatsApp do cliente, e queimaria cota do limite de 10
//     registros/72h daquele número;
//   - mexer no PIN de 2 etapas: ele pertence ao número e continua valendo;
//     apagá-lo do nosso lado é o que impediria reconectar depois (erro
//     133005);
//   - apagar conversas, mensagens, agenda ou base de conhecimento.
//
// A ordem importa: o unsubscribe precisa do accessToken, então acontece ANTES
// da limpeza que o descarta.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import {
  getEstablishment,
  disconnectWhatsapp,
  hasOtherConnectedEstablishmentWithWaba,
} from "@/lib/repo";
import { unsubscribeAppFromWaba, graphErrorOf } from "@/lib/whatsapp/embedded";
import { decryptToken } from "@/lib/whatsapp/tokenCrypto";
import type { EncryptedToken } from "@/types";

// Tira o app da Livia dos webhooks da WABA. Best-effort de propósito: se
// falhar, a desconexão CONTINUA.
//
// A intenção do estabelecimento tem que prevalecer — caso contrário uma
// instabilidade da Meta o prenderia no estado conectado, sem saída pelo
// painel. O impacto de não desinscrever é contido: as mensagens até chegam,
// mas o webhook as descarta, porque só atende estabelecimento "connected"
// (ver findEstablishmentByPhoneNumberId).
async function tryUnsubscribe(
  id: string,
  wabaId: string,
  encryptedToken: EncryptedToken,
): Promise<void> {
  try {
    // Outro estabelecimento conectado na MESMA WABA: desinscrever derrubaria
    // os webhooks dele também. Não é erro — é o caso legítimo de uma WABA com
    // vários números; simplesmente não removemos a inscrição.
    if (await hasOtherConnectedEstablishmentWithWaba(wabaId, id)) {
      console.info(
        `[whatsapp disconnect] inscrição da WABA mantida (estabelecimento=${id}): ` +
          `outro estabelecimento conectado usa a mesma WABA.`,
      );
      return;
    }
    const token = decryptToken(encryptedToken);
    await unsubscribeAppFromWaba(wabaId, token);
  } catch (err) {
    const graph = graphErrorOf(err);
    const detail = graph ? ` graph=${JSON.stringify(graph)}` : "";
    console.error(
      `[whatsapp disconnect] falha ao remover inscrição da WABA (estabelecimento=${id})` +
        `${detail} — desconectando mesmo assim.`,
    );
  }
}

export async function POST(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  // Lê o estado ANTES de limpar: o unsubscribe depende do accessToken, que a
  // limpeza remove.
  const est = await getEstablishment(id);
  const wa = est?.whatsapp;

  if (wa?.status === "connected" && wa.accessToken && wa.wabaId) {
    await tryUnsubscribe(id, wa.wabaId, wa.accessToken);
  }

  let result: Awaited<ReturnType<typeof disconnectWhatsapp>>;
  try {
    result = await disconnectWhatsapp(id);
  } catch (err) {
    console.error(`[whatsapp disconnect] falha ao limpar o estado (estabelecimento=${id})`, err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  if (result.outcome === "in_progress") {
    return NextResponse.json({ error: "CONNECTION_IN_PROGRESS" }, { status: 409 });
  }

  // "disconnected" e "already_disconnected" são ambos sucesso: o botão não
  // deve dar erro por clique repetido, e o estado final é o mesmo.
  return NextResponse.json({ connected: false });
}
