// GET  /api/whatsapp/connect -> status da conexão de WhatsApp (painel).
// POST /api/whatsapp/connect -> finaliza o Embedded Signup.
//
// Tenant SEMPRE via resolveEstablishmentId(req) (sessão) — nunca aceito do
// corpo da requisição.
//
// Garantias centrais desta rota (ver lib/repo.ts para os detalhes):
//   1. O PIN de registro é gerado e persistido CIFRADO (status "connecting")
//      ANTES de qualquer chamada a /register — um PIN aceito pela Meta nunca
//      fica só em memória do processo, mesmo que tudo depois falhe.
//   2. Uma lease exclusiva (attemptId + leaseExpiresAt), assumida dentro de
//      uma transação do Firestore, garante que só UMA requisição por vez
//      executa a sequência de conexão de um estabelecimento — mesmo que duas
//      cheguem com o mesmo wabaId/phoneNumberId ao mesmo tempo.
//   3. finalizeWhatsappConnection só grava "connected" se o attemptId que
//      está finalizando ainda for o dono da lease — uma tentativa antiga que
//      demorou demais nunca sobrescreve o resultado de uma tentativa mais
//      nova que já assumiu.
//   4. Qualquer falha (exchange/ownership/subscribe/register) libera a lease
//      imediatamente, sem apagar o PIN cifrado, permitindo nova tentativa
//      sem esperar o TTL inteiro.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import {
  getEstablishment,
  claimWhatsappConnection,
  finalizeWhatsappConnection,
  releaseWhatsappConnectionAttempt,
} from "@/lib/repo";
import {
  exchangeCodeForToken,
  getWabaPhoneNumbers,
  subscribeAppToWaba,
  registerPhoneNumber,
  graphErrorOf,
} from "@/lib/whatsapp/embedded";
import { encryptToken } from "@/lib/whatsapp/tokenCrypto";

const ID_PATTERN = /^\d+$/;

// Categoria interna + estabelecimento + etapa. Quando a falha veio da Graph
// API, inclui também o diagnóstico SANITIZADO da própria Meta (status, type,
// code, subcode, message já filtrada e fbtrace_id) — é o que permite
// distinguir, por exemplo, "App Secret errado" (code 1, "Error validating
// client secret") de "code expirado" ou de falta de permissão. Nunca inclui
// token, app secret, code OAuth ou PIN: ver safeMessage() em
// lib/whatsapp/embedded.ts.
function logFailure(step: string, establishmentId: string, err?: unknown): void {
  const graph = err !== undefined ? graphErrorOf(err) : undefined;
  const detail = graph ? ` graph=${JSON.stringify(graph)}` : "";
  console.error(
    `[whatsapp connect] falha em "${step}" (estabelecimento=${establishmentId})${detail}`,
  );
}

// Libera a lease (best-effort — se falhar, o TTL da lease garante que a
// tentativa trava no máximo WHATSAPP_CONNECT_LEASE_TTL_MS) e devolve a
// resposta de erro sanitizada.
async function abort(
  id: string,
  attemptId: string,
  step: string,
  errorCode: string,
  status: number,
  err?: unknown,
): Promise<NextResponse> {
  logFailure(step, id, err);
  await releaseWhatsappConnectionAttempt(id, attemptId).catch(() => {});
  return NextResponse.json({ error: errorCode }, { status });
}

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const est = await getEstablishment(id);
  const wa = est?.whatsapp;
  if (!wa || wa.status !== "connected") {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    phoneNumberId: wa.phoneNumberId,
    wabaId: wa.wabaId,
    connectedAt: wa.connectedAt,
    tokenRefreshedAt: wa.tokenRefreshedAt,
  });
}

export async function POST(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const raw = (await req.json().catch(() => null)) as {
    code?: unknown;
    wabaId?: unknown;
    phoneNumberId?: unknown;
  } | null;
  const code = raw?.code;
  const wabaId = raw?.wabaId;
  const phoneNumberId = raw?.phoneNumberId;
  if (
    typeof code !== "string" ||
    !code ||
    typeof wabaId !== "string" ||
    !ID_PATTERN.test(wabaId) ||
    typeof phoneNumberId !== "string" ||
    !ID_PATTERN.test(phoneNumberId)
  ) {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }

  // 1. Assume a lease exclusiva — também é aqui que o PIN nasce e já fica
  // persistido cifrado, antes de qualquer chamada Graph API.
  // O try/catch existe porque esta etapa depende de WHATSAPP_TOKEN_ENC_KEY:
  // sem a env, `encryptPin` lança e a rota devolvia um 500 sem nenhum log
  // útil, aparecendo no painel só como "Algo deu errado ao conectar".
  let claim: Awaited<ReturnType<typeof claimWhatsappConnection>>;
  try {
    claim = await claimWhatsappConnection(id, wabaId, phoneNumberId);
  } catch (err) {
    logFailure("claim", id, err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
  if (claim.outcome === "already_connected") {
    return NextResponse.json({ error: "ALREADY_CONNECTED" }, { status: 409 });
  }
  if (claim.outcome === "conflict") {
    return NextResponse.json({ error: "CONNECTION_IN_PROGRESS" }, { status: 409 });
  }
  const { pin, attemptId } = claim; // "claimed" (novo) ou "resumed" (retomando)

  // 2. code -> business token do estabelecimento (só em memória).
  let accessToken: string;
  try {
    accessToken = await exchangeCodeForToken(code);
  } catch (err) {
    return abort(id, attemptId, "exchange", "EXCHANGE_FAILED", 502, err);
  }

  // 3. Verificação de posse: consulta os números da WABA COM o token
  // recém-obtido. Este token só existe porque a Meta o emitiu para ESTA
  // sessão específica de Embedded Signup (o `code` trocado no passo 2 veio
  // do mesmo popup que devolveu wabaId/phoneNumberId) — não é um token
  // genérico da Livia com acesso amplo. Se o token não tiver acesso a essa
  // WABA, a própria chamada falha (erro de permissão da Meta); se tiver,
  // confere se phoneNumberId está mesmo na lista — nunca confia apenas nos
  // IDs que o frontend enviou. Uma única chamada prova as duas coisas: posse
  // da WABA (a chamada só funciona se o token tiver acesso) e pertencimento
  // do número (está ou não na lista retornada).
  try {
    const numbers = await getWabaPhoneNumbers(wabaId, accessToken);
    if (!numbers.includes(phoneNumberId)) {
      return abort(id, attemptId, "ownership (phoneNumberId fora da lista da WABA)", "OWNERSHIP_MISMATCH", 502);
    }
  } catch (err) {
    return abort(id, attemptId, "ownership", "OWNERSHIP_MISMATCH", 502, err);
  }

  // 4. Inscreve o app da Livia na WABA (webhooks).
  try {
    await subscribeAppToWaba(wabaId, accessToken);
  } catch (err) {
    return abort(id, attemptId, "subscribe", "SUBSCRIBE_FAILED", 502, err);
  }

  // 5. Registra o número com o PIN já persistido cifrado no passo 1. Só dois
  // resultados não abortam: sucesso real, ou "já registrado/já existe"
  // explicitamente reconhecido pela Graph API (comum em Coexistence) —
  // qualquer outro erro (PIN incorreto, número não verificado, rate limit,
  // código desconhecido) aborta. O PIN já persistido continua seguro no
  // Firestore mesmo que este passo falhe — uma nova tentativa com o mesmo
  // wabaId/phoneNumberId retoma ("resumed") e reaproveita o mesmo PIN.
  let registeredAt: number | undefined;
  try {
    const result = await registerPhoneNumber(phoneNumberId, accessToken, pin);
    if (result.registered) registeredAt = Date.now();
    // alreadyRegistered === true: não fomos nós que registramos agora,
    // registeredAt fica ausente de propósito (ver types/index.ts).
  } catch (err) {
    return abort(id, attemptId, "register", "REGISTER_FAILED", 502, err);
  }

  // 6. Só agora — com toda a sequência obrigatória concluída — cifra o
  // access token e conclui a conexão, desde que a lease ainda seja nossa.
  let finalized: { ok: boolean };
  try {
    finalized = await finalizeWhatsappConnection(id, attemptId, {
      wabaId,
      phoneNumberId,
      accessToken: encryptToken(accessToken),
      registeredAt,
    });
  } catch (err) {
    return abort(id, attemptId, "finalize", "INTERNAL_ERROR", 500, err);
  }

  if (!finalized.ok) {
    // A lease expirou e outra tentativa já assumiu (ou já concluiu) enquanto
    // esta rodava — não é um erro da Meta, é uma corrida perdida. Já fizemos
    // todo o trabalho com a Meta, mas não é seguro sobrescrever quem já tem
    // a lease agora. Não há lease para liberar aqui (já não é mais nossa).
    logFailure("finalize (lease perdida para outra tentativa)", id);
    return NextResponse.json({ error: "STALE_ATTEMPT" }, { status: 409 });
  }

  return NextResponse.json({ connected: true, phoneNumberId, wabaId });
}
