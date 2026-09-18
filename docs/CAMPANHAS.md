# Campanhas

Campanhas reutilizam `CustomerProfile`, conversas e a conexão WhatsApp já
existentes; não criam um segundo CRM ou atendimento paralelo.

## Elegibilidade de marketing

Um perfil sem `marketingStatus` é legado e inelegível por segurança: ter
conversado com a Lívia não equivale a consentimento de marketing.

`opted_out` e `blocked` sempre prevalecem sobre qualquer audiência futura.
Opt-out bloqueia somente marketing; não muda conversa, CRM, agenda ou handoff.

## Importação e opt-in

Uma importação exige declaração explícita do estabelecimento de que os
contatos forneceram o número e aceitaram mensagens WhatsApp de marketing.
O `CustomerProfile` elegível registra data, origem e versão dessa declaração;
`crm_import` identifica a entrada operacional, não substitui a confirmação.

Lotes são limitados a 200 contatos. Bases maiores exigirão processamento
assíncrono futuro, sem tentativa de executar milhares de escritas em uma
request. Reimportação não duplica perfil nem regrava a evidência de opt-in.

## Dispatcher (CAMPANHAS-06)

Fundação operacional de envio: `lib/repo.ts` (claim/lease + counters,
transacional) + `lib/campaignDispatcher.ts` (elegibilidade + chamada à Meta)
+ `app/api/cron/campaigns-dispatch/route.ts` (entrypoint interno, protegido
por `CRON_SECRET`). Uma invocação processa um lote pequeno (padrão 20) de UMA
campanha `running` por vez — nunca a campanha inteira. Campanhas de 5k/10k/20k
recipients avançam por várias invocações sucessivas, não por uma execução só.

**Lease.** Cada recipient tem `leaseOwner`/`leaseExpiresAt` adquiridos numa
transação Firestore por documento (mesmo padrão do connect-claim do WhatsApp
em `EstablishmentWhatsapp`). Dois workers nunca processam o mesmo recipient:
a transação só vence para quem lê o documento ainda `pending`/`queued`
(ou `leased` expirado) e escreve primeiro. Um lease expirado É recuperável
— com uma exceção crítica, abaixo.

**Revalidação de opt-out.** O snapshot de audiência (`prepareCampaignAudience`)
nunca autoriza um envio sozinho. Imediatamente antes de chamar a Meta, o
dispatcher relê o `CustomerProfile` e roda `marketingEligibilityOf` de novo.
`opted_out`, `blocked`, perfil legado sem `marketingStatus` ou perfil
inexistente terminam o recipient como `skipped`, nunca enviam.

**Crash depois da Meta aceitar (o cenário crítico da OT).** Antes de chamar
`sendTemplate`, o dispatcher grava `leaseAttemptStarted = true` (e incrementa
`attempts`) NA MESMA lease — essa escrita acontece antes de qualquer chamada
de rede. Se o processo morrer entre a Meta aceitar o envio e a persistência
do resultado, o lease expira com `leaseAttemptStarted = true` ainda gravado.
Na próxima claim, esse estado NUNCA é reclamado automaticamente: o recipient
é finalizado direto como `failed` com `ambiguous: true` e uma
`failureReason` fixa (`lease_expired_after_send_attempt`), fora do caminho de
retry. Preferimos um recipient parado para reconciliação manual a um
reenvio duplicado. Reconciliação (cruzar `ambiguous: true` com o status real
na Meta) fica para uma OT futura — não implementada aqui.

Se o processo morre ANTES de chamar a Meta (`leaseAttemptStarted` nunca virou
`true`), o lease expirado é livremente reclamado por outro worker: não há
risco de duplicidade porque a Meta nunca foi contatada.

**Classificação de erro** (`classifySendError` em `lib/campaignDispatcher.ts`):
- `config`: WhatsApp do estabelecimento não conectado/sem token — falha o
  recipient, não é retryable (é um problema do tenant, não do envio).
- `permanent`: código de erro da Meta que não muda com retry (template/
  parâmetro inválido, destinatário incapaz de receber) — `failed` direto.
- `rate_limited`: throttling da Meta — agenda retry E interrompe o RESTO do
  lote atual (a próxima invocação retoma).
- `retryable`: qualquer outro erro HTTP com resposta confirmada da Meta —
  agenda retry com backoff.
- `ambiguous`: erro sem resposta HTTP confirmada (rede caiu, timeout,
  processo morreu no meio do fetch) — nunca reagenda retry automático;
  mesmo tratamento do lease expirado pós-tentativa, acima.

**Retry.** `attempts` (no recipient) + backoff exponencial por tentativa
(30s, 60s, 2min, 4min, 8min, teto 30min) via `nextAttemptAt`. Acima de
`CAMPAIGN_DISPATCH_MAX_ATTEMPTS` (5), o recipient falha permanentemente sem
nova tentativa de rede. `lastError`/`failureReason` sempre sanitizado (sem
token, truncado).

**Rate control.** O dispatcher nunca promete mensagens/segundo: o tamanho do
lote (`batchSize`, padrão 20) é independente do tamanho da campanha, e
throttling da Meta interrompe o lote em andamento. A cadência REAL de envio
é controlada por quem invoca o endpoint (ex.: intervalo entre chamadas de
um cron), não por este código.

**Contadores.** `Campaign.counters` só avança dentro da mesma transação que
finaliza o recipient (`sent`/`failed`/`skipped`), e só se o recipient ainda
estiver `leased` por aquele worker — uma finalização repetida (lease já
perdido/já finalizado por outro) é um no-op seguro, nunca duplica contagem.
`delivered`/`read`/`replied` não avançam nesta OT (dependem de status vindo
da Meta — próxima OT).

**Não conectado ao painel.** O endpoint existe mas não está em
`vercel.json` `crons` nem é chamado pelo botão "Enviar agora" — habilitar
qualquer um dos dois é uma decisão explícita de uma OT futura, não desta.

## Status Meta + Replies (CAMPANHAS-07)

Fecha a observabilidade usando o MESMO webhook do WhatsApp
(`app/api/webhooks/whatsapp/route.ts`) — nenhum endpoint novo. Dois hooks,
ambos em `lib/repo.ts`:

- `applyCampaignDeliveryStatus` — correlaciona um status callback da Meta
  (`change.value.statuses[]`, já classificado como `"status"` por
  `classifyWebhookChange`) ao `CampaignRecipient` dono do `metaMessageId`.
- `correlateCampaignReply` — quando chega uma mensagem inbound normal,
  procura um `CampaignRecipient` recente para aquele telefone e marca
  `replied`.

Em ambos os casos o tenant vem SEMPRE de `findEstablishmentByPhoneNumberId`
(resolvido a partir de `metadata.phone_number_id`, o mesmo caminho já usado
por `processMessage`) — nunca de qualquer campo do corpo do webhook, que
nem carrega establishmentId no formato real da Meta.

**Monotonicidade.** `sent`(1) → `delivered`(2) → `read`(3) é uma ordem
estrita: só aplica se o novo status tiver rank maior que o atual — um
evento atrasado ou duplicado nunca regride nem duplica counters (não há
`_processed_*` novo; a própria checagem de rank já torna a operação
idempotente). "read" sem um "delivered" prévio credita OS DOIS counters de
uma vez (`read` implica `delivered`/`sent` conceitualmente). `failed`
pós-envio só se aplica a partir de status "sent" puro (nunca regride
delivered/read) e soma em `counters.failed` SEM subtrair de `counters.sent`
— o envio de fato aconteceu; `sent`/`delivered`/`read` são um funil aditivo
(cada estágio é um fato histórico, não um "bucket" que se esvazia), diferente
do `queued→sent/failed/skipped` do dispatcher (esse sim uma partição
mutuamente exclusiva). `failureReason` guarda só `code`+`title` sanitizados
da Meta, nunca o payload bruto.

**Correlação de reply.** Um `CampaignRecipient` é elegível para virar
`replied` se `status` é `sent`/`delivered`/`read` (já foi enviado, ainda não
respondido) e `sentAt` está dentro de uma janela de 7 dias
(`REPLY_CORRELATION_WINDOW_MS`) — campanha mais antiga que isso nunca
recebe a resposta, mesmo sem nenhum candidato mais novo. Se houver mais de
um candidato elegível para o mesmo telefone (o cliente recebeu duas
campanhas recentes), vence o de `sentAt` mais recente (critério
determinístico; `id` como desempate estável) — nunca "cai" para uma
campanha mais antiga só porque a mais nova já foi respondida antes.
`replied` é terminal: uma segunda resposta encontra o recipient já
`replied` e não incrementa `counters.replied` de novo.

**Nunca interfere no fluxo normal.** O hook de reply roda logo após
`loadConversation` (antes de qualquer branch/early-return do webhook) e
está isolado em `try/catch` — uma falha na correlação nunca impede a
resposta da IA, a persistência da conversa, handoff, agenda ou CRM. O
mesmo vale para o hook de status: roda dentro do próprio `try/catch` do
laço de classificação de `handleWebhook`, nunca propaga erro para o resto
do payload.

**Frontend.** Nenhuma mudança foi necessária: `/api/campaigns` e
`/api/campaigns/:id` já devolvem `Campaign`/`CampaignRecipient` reais e sem
transformação, e `CampaignDetail`/`CampaignsTable` (OT-FRONT-CAMPANHAS-01)
já renderizam `counters.sent/delivered/read/replied/failed` diretamente —
os novos valores aparecem no painel assim que persistidos, sem nenhum
código novo de UI.

**Gaps para CAMPANHAS-08.** Reconciliação de recipients `ambiguous: true`
(CAMPANHAS-06) continua não implementada. Não há vínculo
`CampaignRecipient` → `conversationId` (a linha "Ver conversa" do painel
continua um placeholder inerte). O `wamid` do "Ver conversa" ou de uma
futura auditoria de mensagens não é persistido em `Message` — só em
`CampaignRecipient.metaMessageId`.
