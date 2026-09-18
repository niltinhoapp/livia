# CAMPANHAS-08 — auditoria mínima e delta

Base auditada: `a10cdb2ae4b3ad67063a73dfdc624ca0d6174244`.

## Encontrado

- `Campaign`: `draft`, `scheduled`, `running`, `completed`, `canceled`; template e audiência são snapshots; counters são persistidos no documento do tenant.
- `CampaignRecipient`: materializado em `campaignRecipients`, com elegibilidade revalidada, lease, retry/backoff, `ambiguous` e estados terminais.
- Dispatcher CAMPANHAS-06: lote pequeno, claim transacional, lease e sender separado; já não reenvia automaticamente após tentativa ambígua.
- CAMPANHAS-07: status Meta correlacionado por `metaMessageId` e reply por telefone/janela, preservando a conversa normal.
- APIs/frontend: criação, preparação de audiência, templates, listagem e detalhe reais já existiam; faltava apenas a transição explícita para o dispatcher.
- Cron: endpoint existente protegido por `CRON_SECRET`, mas não estava em `vercel.json`.

## Menor delta implementado

1. `POST /api/campaigns/{id}/send` resolve o tenant pela sessão, exige confirmação,
   WhatsApp conectado, template APPROVED/compatível, snapshot e recipients; não
   chama Meta.
2. A transição ocorre uma única vez em transação. `scheduledAt` futuro usa
   `scheduled`; o dispatcher promove quando vence.
3. `CAMPAIGNS_SEND_ENABLED=false` é o default e bloqueia ativação e cron.
   `CAMPAIGNS_MAX_RECIPIENTS_PER_CAMPAIGN` tem default 5 e teto 200.
4. O dispatcher existente foi apenas conectado à promoção de agendamento e à
   conclusão após não haver `pending`, `queued` ou `leased`.
5. O detalhe passou a exibir confirmação explícita para “Enviar agora”; a
   listagem/detalhe continuam consumindo dados reais.

Não foi adicionado cron a `vercel.json`, nem criada infraestrutura externa.
