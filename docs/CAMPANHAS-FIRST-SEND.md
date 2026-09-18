# Runbook — primeiro disparo real de Campanhas

Este procedimento é manual. A implementação e os testes automatizados não
enviam mensagens reais.

## Pré-condições

- PR revisada e mergeada; Production READY.
- `CAMPAIGNS_SEND_ENABLED=false` confirmado durante a revisão e alterado para
  `true` somente no momento autorizado.
- `CRON_SECRET` configurado e cron autenticado.
- Template Meta real em `APPROVED`, `senderCompatible=true`.
- Estabelecimento conectado e 1–3 números próprios/controlados com opt-in
  registrado. Não usar clientes reais.
- `CAMPAIGNS_MAX_RECIPIENTS_PER_CAMPAIGN=5`.

## Execução

1. Criar uma campanha e materializar a audiência controlada.
2. Confirmar no detalhe nome, template, recipients e consentimento.
3. Habilitar o kill switch conscientemente e executar **Confirmar envio** uma
   única vez. Não chamar o endpoint de dispatcher manualmente em Production.
4. Acompanhar no detalhe: `sent` → `delivered` → `read` → resposta.
5. Confirmar `CampaignRecipient=replied`, contador `replied` e que a resposta
   segue a conversa normal da Lívia.
6. Desabilitar o kill switch após a validação e registrar IDs/horários sem
   registrar tokens ou números completos.

## Rollback

Definir `CAMPAIGNS_SEND_ENABLED=false`. Isso impede novas ativações e faz o
dispatcher retornar sem enviar. Recipients já aceitos pela Meta não podem ser
desfeitos; acompanhar seus webhooks e manter a proteção de `ambiguous`.
