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

## Próximos passos

1. Painel do estabelecimento para cadastrar a base de conhecimento.
2. Conexão do WhatsApp via Embedded Signup (portar do Nuvem Rush).
3. Motor de agenda: horários, confirmação, remarcação, lembrete anti-no-show.
4. Handoff completo: notificar o atendente e caixa de entrada no painel.
5. Suporte a áudio/imagem nas mensagens recebidas.
6. Mover o processamento pesado para fila (Cloud Tasks) em volume alto.
