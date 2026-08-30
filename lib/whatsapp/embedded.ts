// Meta Embedded Signup (modelo Tech Provider) — funções da Graph API usadas
// para finalizar a conexão do WhatsApp de CADA estabelecimento. Adaptado do
// mesmo módulo no Nuvem Rush (lib/whatsapp/embedded.ts), removendo tudo que
// era específico de e-commerce (template de pós-venda, schema `stores`).
//
// Fluxo completo (a parte de UI/rota ainda não existe — ver TODOs no fim):
//   1. Estabelecimento clica "Conectar WhatsApp" -> popup da Meta (FB.login
//      com config_id) -> ele cria/escolhe a própria WABA e o próprio número.
//   2. O popup devolve um `code` (OAuth) + waba_id + phone_number_id.
//   3. O backend troca o code por um BUSINESS TOKEN do estabelecimento,
//      inscreve o app da Livia na WABA dele (webhooks) e registra o número.
//
// Cada estabelecimento continua dono do próprio Business/WABA/número — a
// Meta cobra as conversas direto dele, nunca da Livia.
//
// Env necessárias: NEXT_PUBLIC_META_APP_ID, META_APP_SECRET.
// Pré-requisitos na Meta (fora do código): app "Livia" com App Review
// concluído para whatsapp_business_management + whatsapp_business_messaging,
// fluxo "Provedor de Tecnologia" concluído no Business da ConectWeb e uma
// Configuration do Embedded Signup criada (NEXT_PUBLIC_WHATSAPP_ES_CONFIG_ID).
//
// Segurança de token: nenhuma função aqui loga, persiste ou devolve o access
// token para o frontend — ele só existe em memória, no retorno da função, e
// cabe à rota backend que ainda vai chamar isto (futura /api/whatsapp/connect)
// cifrá-lo com lib/whatsapp/tokenCrypto.ts antes de gravar em qualquer lugar.

const GRAPH_VERSION = "v24.0";
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Lê e valida as credenciais do Meta App a cada chamada — mesmo padrão do
// tokenCrypto.ts (nunca cacheadas em módulo, erro explícito se ausentes).
// NEXT_PUBLIC_META_APP_ID é usada aqui no servidor de propósito: o App ID não
// é secreto (a Meta o expõe no próprio popup do Embedded Signup) e o mesmo
// valor já precisa existir como env pública para o SDK JS no frontend: uma
// env server-only separada (ex. META_APP_ID) só duplicaria o mesmo valor sem
// ganho de segurança. Já o App Secret é sempre server-only (META_APP_SECRET,
// nunca NEXT_PUBLIC_*).
function loadAppCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      "NEXT_PUBLIC_META_APP_ID / META_APP_SECRET ausentes — não é possível falar com a Graph API da Meta.",
    );
  }
  return { appId, appSecret };
}

// Formata o corpo de erro da Graph API em uma mensagem útil, SEM jamais
// incluir token/secret (nenhum dos dois aparece nesses payloads de erro da
// Meta, mas o parsing aqui é propositalmente restrito aos campos de erro).
async function graphJson(res: Response, action: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (body as { error?: { message?: string; code?: number; error_user_title?: string } }).error;
    const detail = err?.error_user_title ?? err?.message ?? JSON.stringify(body);
    throw new Error(`Graph API (${action}) ${res.status}: ${detail}`);
  }
  return body;
}

// Troca o `code` retornado pelo Embedded Signup por um business token do
// estabelecimento (token de longa duração, escopado à WABA que ele conectou).
// O token só existe em memória aqui — quem chamar esta função decide como
// cifrar/gravar (não é feito neste módulo).
export async function exchangeCodeForToken(code: string): Promise<string> {
  const { appId, appSecret } = loadAppCredentials();
  const url =
    `${GRAPH_BASE_URL}/oauth/access_token?client_id=${appId}` +
    `&client_secret=${appSecret}&code=${encodeURIComponent(code)}`;
  const body = await graphJson(await fetch(url), "exchangeCodeForToken");
  const token = body.access_token as string | undefined;
  if (!token) {
    throw new Error("Graph API (exchangeCodeForToken): resposta sem access_token.");
  }
  return token;
}

// Renova um business token antes de ele expirar (a Configuration do Embedded
// Signup emite tokens de usuário de sistema com validade de 60 dias). A troca
// fb_exchange_token devolve um token NOVO com mais 60 dias; o antigo continua
// válido até expirar — cabe a quem chamar decidir quando substituir o
// armazenado (esta função não persiste nada).
export async function refreshBusinessToken(currentToken: string): Promise<string> {
  const { appId, appSecret } = loadAppCredentials();
  const url =
    `${GRAPH_BASE_URL}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${appId}&client_secret=${appSecret}` +
    `&fb_exchange_token=${encodeURIComponent(currentToken)}`;
  const body = await graphJson(await fetch(url), "refreshBusinessToken");
  const token = body.access_token as string | undefined;
  if (!token) {
    throw new Error("Graph API (refreshBusinessToken): resposta sem access_token.");
  }
  return token;
}

// Lista os phone_number_id que a WABA `wabaId` realmente possui, consultados
// COM o token recém-obtido do estabelecimento (não com o app secret). Serve
// de verificação de posse antes de qualquer subscribe/register: se o token
// não tiver acesso a essa WABA, a própria chamada falha (erro de permissão
// da Meta); se tiver, a lista devolvida é a fonte da verdade de quais
// números pertencem a ela — nunca confiar apenas no phoneNumberId que o
// frontend informou.
//
// Não pagina resultados (cenário típico: 1 estabelecimento, poucos números
// por WABA) — se algum dia surgir uma WABA com muitas dezenas de números,
// revisar para seguir `paging.next`.
export async function getWabaPhoneNumbers(wabaId: string, token: string): Promise<string[]> {
  const body = await graphJson(
    await fetch(`${GRAPH_BASE_URL}/${wabaId}/phone_numbers`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    "getWabaPhoneNumbers",
  );
  const data = (body.data as Array<{ id?: string }> | undefined) ?? [];
  return data.map((p) => p.id).filter((id): id is string => Boolean(id));
}

// Inscreve o app da Livia na WABA do estabelecimento — obrigatório para
// recebermos os webhooks (mensagens, status de entrega) da conta dele.
export async function subscribeAppToWaba(wabaId: string, token: string): Promise<void> {
  await graphJson(
    await fetch(`${GRAPH_BASE_URL}/${wabaId}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }),
    "subscribeAppToWaba",
  );
}

// Códigos de erro documentados pela Meta para POST /{phone_number_id}/register
// (docs: business-messaging/whatsapp/business-phone-numbers/registration) que
// representam falha REAL — nunca devem ser tratados como sucesso, mesmo que a
// mensagem de texto pareça inofensiva:
//   133000 deregistro anterior falhou (precisa completar antes de tentar de novo)
//   133005 PIN de 2 etapas incorreto
//   133006 número precisa ser verificado antes de registrar
//   133008 muitas tentativas de PIN
//   133009 PIN enviado rápido demais
//   133010 número ainda não registrado (fluxo incompleto)
//   133015 número foi deletado recentemente, exclusão não concluída
//   133016 rate limit (máx. 10 tentativas/72h por número)
const REGISTER_KNOWN_FAILURE_CODES = new Set([
  133000, 133005, 133006, 133008, 133009, 133010, 133015, 133016,
]);

// Único código documentado que indica "o número já está registrado/já existe
// na conta" — tratado como não-fatal. Qualquer OUTRO código (conhecido de
// falha ou desconhecido) nunca vira sucesso automaticamente.
const REGISTER_ALREADY_EXISTS_CODES = new Set([2388012]);

// Registra o número na Cloud API. Necessário para números NOVOS criados via
// Embedded Signup; números que já vêm em coexistência com o app oficial do
// WhatsApp Business podem já estar registrados (código 2388012), tratado
// aqui como não-fatal — mas SOMENTE por código, nunca por regex de texto.
// Texto de erro (message/error_user_title) só entra na mensagem lançada como
// informação complementar de diagnóstico, nunca como critério de decisão.
//
// PIN: é a verificação em 2 etapas *do número do estabelecimento* — não um
// segredo da Livia. Recebido como parâmetro obrigatório, sem default e sem
// valor fixo compartilhado entre estabelecimentos; a geração/armazenamento
// seguro do PIN por estabelecimento é decisão da futura rota de conexão.
export async function registerPhoneNumber(
  phoneNumberId: string,
  token: string,
  pin: string,
): Promise<{ registered: boolean; alreadyRegistered: boolean }> {
  const res = await fetch(`${GRAPH_BASE_URL}/${phoneNumberId}/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
  if (res.ok) return { registered: true, alreadyRegistered: false };

  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: number; error_subcode?: number; message?: string; error_user_title?: string };
  };
  const code = body.error?.code;
  const subcode = body.error?.error_subcode;
  // Só como diagnóstico complementar no erro lançado — nunca decide sucesso.
  const diagnosticText = body.error?.error_user_title ?? body.error?.message ?? "";

  if (code !== undefined && REGISTER_ALREADY_EXISTS_CODES.has(code)) {
    return { registered: false, alreadyRegistered: true };
  }

  if (code !== undefined && REGISTER_KNOWN_FAILURE_CODES.has(code)) {
    throw new Error(
      `Graph API (registerPhoneNumber): erro conhecido ${code}` +
        (subcode ? `/${subcode}` : "") +
        (diagnosticText ? ` — ${diagnosticText}` : ""),
    );
  }

  // Código desconhecido/ausente: nunca vira sucesso silencioso.
  throw new Error(
    `Graph API (registerPhoneNumber): erro não reconhecido (HTTP ${res.status}` +
      (code !== undefined ? `, code ${code}` : "") +
      (subcode !== undefined ? `/${subcode}` : "") +
      `)` +
      (diagnosticText ? ` — ${diagnosticText}` : ""),
  );
}
