# Livia

Atendente virtual com IA no WhatsApp para clínicas, pets, salões e serviços
locais. A Livia **responde dúvidas** com base nas informações do
estabelecimento, **reduz faltas** com lembretes e (fase 2) **agenda horários**
— tudo pelo número de WhatsApp do próprio negócio.

## Stack

Mesma base do Nuvem Rush: **Next.js (App Router) + TypeScript + Firebase
(Firestore) + Vercel**, integrado à **Meta Cloud API** via Embedded Signup
(modelo Tech Provider — cada estabelecimento conecta a própria conta e a Meta
cobra as conversas direto dele).

## Como o núcleo funciona (bot com IA)

```
Cliente manda msg no WhatsApp
        │
        ▼
/api/webhooks/whatsapp (POST)
        │
        ├─ identifica o estabelecimento pelo phone_number_id
        ├─ carrega a base de conhecimento (serviços, horários, FAQs…)
        ├─ carrega o histórico recente da conversa
        ├─ IA (lib/ai/brain) gera a resposta — só com base no que está cadastrado
        └─ envia a resposta por texto livre (janela de 24h) e registra tudo
```

Ponto-chave: a IA responde **somente** com a base de conhecimento do
estabelecimento. Se não sabe, não inventa — oferece transferir para um
atendente (marcador `[[HANDOFF]]`, que troca a conversa para modo humano).

## Estrutura

- `types/index.ts` — modelo de domínio (Establishment, KnowledgeBase, Conversation, Message).
- `lib/firebase/admin.ts` — Firestore admin (multi-tenant sob `establishments/{id}`).
- `lib/whatsapp/client.ts` — envio de texto livre + marcar como lida.
- `lib/ai/brain.ts` — o "cérebro": monta o prompt com a base de conhecimento e responde.
- `lib/repo.ts` — leitura/escrita de estabelecimentos, conversas e mensagens (+ dedupe de webhook).
- `app/api/webhooks/whatsapp/route.ts` — o núcleo (recebe → pensa → responde).

## Variáveis de ambiente

Ver `.env.example`. Precisa de Firebase Admin, `OPENAI_API_KEY`,
`WHATSAPP_WEBHOOK_VERIFY_TOKEN` e as credenciais do Embedded Signup.

## Agenda (motor de agendamento)

- `lib/scheduling.ts` — config da agenda, cálculo de horários livres (descontando pausas, antecedência mínima e conflitos) e CRUD de agendamentos.
- `app/api/schedule` — configuração da agenda (horários por dia, slot, fuso, template de lembrete).
- `app/api/availability` — horários livres de um dia.
- `app/api/appointments` (+ `/[id]`) — criar, listar, confirmar, cancelar, remarcar.
- `app/api/cron/reminders` — lembrete anti-no-show por **template** (envio proativo fora da janela de 24h exige HSM aprovado).
- Webhook captura a resposta ao lembrete (`SIM` confirma, `CANCELAR` desmarca).

## Próximos passos

1. ✅ Painel da base de conhecimento (feito).
2. ✅ Motor de agenda + lembrete anti-no-show (feito).
3. ✅ Painel visual da agenda — `app/painel/agenda` (visão do dia, ações de status, novo agendamento com horários livres).
4. ✅ Booking pela IA — o bot marca sozinho na conversa via function calling (`lib/ai/brain.ts`: ferramentas `check_availability` e `create_appointment`). Requer `bot.bookingEnabled = true` no estabelecimento.
5. Painel de configuração da agenda (horários por dia, pausas, template de lembrete) + config do bot (persona, tom, bookingEnabled, guardrail).
6. Conexão do WhatsApp via Embedded Signup (app separado da Livia + App Review).
5. Conexão do WhatsApp via Embedded Signup (portar do Nuvem Rush, app separado da Livia).
6. Criar/aprovar o template de lembrete na WABA de cada estabelecimento.
7. Login/sessão no painel (hoje o tenant vem por `?est=` em dev).
8. Handoff completo: notificar o atendente e caixa de entrada no painel.
9. Suporte a áudio/imagem; mover processamento pesado para fila em volume alto.
