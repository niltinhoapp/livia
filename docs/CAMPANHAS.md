# Campanhas

Campanhas reutilizam `CustomerProfile`, conversas e a conexão WhatsApp já
existentes; não criam um segundo CRM ou atendimento paralelo.

## Elegibilidade de marketing

Um perfil sem `marketingStatus` é legado e inelegível por segurança: ter
conversado com a Lívia não equivale a consentimento de marketing.

`opted_out` e `blocked` sempre prevalecem sobre qualquer audiência futura.
Opt-out bloqueia somente marketing; não muda conversa, CRM, agenda ou handoff.
