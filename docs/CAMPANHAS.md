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
