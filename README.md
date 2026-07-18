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

## Feito

- ✅ Núcleo do bot com IA (webhook → base de conhecimento → resposta).
- ✅ Painel da base de conhecimento (`app/painel/conhecimento`).
- ✅ Motor de agenda + lembrete anti-no-show.
- ✅ Painel visual da agenda (`app/painel/agenda`).
- ✅ Booking pela IA via function calling (`lib/ai/brain.ts`; requer `bot.bookingEnabled`).
- ✅ Painel de config (`app/painel/config`: estabelecimento + bot + agenda).
- ✅ Deploy na Vercel + Firestore próprio (`livia-6230b`, São Paulo). Painéis testados em produção.

## Próximos passos

1. Conexão do WhatsApp via Embedded Signup (app separado da Livia + App Review na Meta).
2. Criar/aprovar o template de lembrete na WABA de cada estabelecimento.
3. **Verificação do número por OTP** (anti-fake) — ver seção abaixo.
4. Login/sessão no painel — hoje o tenant vem por `?est=` (inseguro, temporário); trocar por JWT em `lib/auth/session.ts`.
5. Handoff completo: notificar o atendente e caixa de entrada no painel.
6. Suporte a áudio/imagem; mover processamento pesado para fila em volume alto.

## Verificação do número por OTP (anti-fake)

Objetivo: garantir que o telefone de um agendamento é real e pertence ao cliente.

Regra de ouro — **só é preciso verificar quando o número NÃO veio de uma
mensagem do WhatsApp:**

- **Agendamento pelo bot** (cliente conversa no WhatsApp): o número já está
  provado (a mensagem chegou daquele número). Confirma direto, sem OTP.
- **Agendamento manual** (dono digita o número) ou **via formulário/web**
  (futuro widget "agende aqui"): o número pode ser errado/inventado → pede OTP.

Fluxo proposto (quando o WhatsApp estiver ligado):

1. Ao criar um agendamento de origem `manual`/`web`, status inicial fica
   `pending` (aguardando verificação).
2. Livia envia um **template de Autenticação da Meta** (categoria "Authentication",
   OTP de código único; custo ~R$0,03) com um código de 6 dígitos.
3. O cliente responde/toca com o código; o webhook valida contra o código
   gerado (guardar hash + expiração curta, ex. 10 min, no doc do agendamento).
4. Código correto → status vira `confirmed`. Errado/expirado → reenvia ou cai
   pra revisão manual do dono.

Depende de: WhatsApp conectado (Embedded Signup) + um template de OTP aprovado
na WABA. Por isso fica para depois de ligar a Meta.
