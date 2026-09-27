# Lívia — Áudio / Voz

> Estado atualizado em 26/09/2026: funcionalidade operacional em produção. Este documento não é mais um plano de MVP.

## Estado atual

A Lívia recebe áudio do WhatsApp, baixa a mídia com segurança, transcreve e entrega a transcrição ao pipeline normal da conversa.

Quando a configuração de voz do estabelecimento permite, a resposta pode ser sintetizada e enviada em áudio.

```text
áudio do cliente
→ Meta webhook
→ download seguro
→ transcrição
→ pipeline normal da IA
→ tools/contexto
→ resposta
→ TTS quando aplicável
```

## Princípio

Áudio é modalidade de entrada, não uma sessão separada. A transcrição participa do mesmo contexto, agenda, CRM, pedidos e handoff.

## Conteúdo estruturado

Nem toda entrada em áudio deve gerar saída em áudio.

Em produção, `shouldReplyWithVoice()` considera ferramentas usadas na resposta. Conteúdo estruturado/visual deve permanecer em texto quando isso melhora legibilidade, incluindo cardápio e outras listas estruturadas.

A correção foi validada em produção no commit `96f73c8`.

Resultado esperado:

```text
cliente: áudio “me manda o cardápio”
→ Lívia entende o áudio
→ consulta cardápio
→ responde o cardápio em TEXTO

cliente: próximo áudio conversacional normal
→ Lívia pode voltar a responder em ÁUDIO
```

A exceção é por resposta; não desliga voz para a conversa inteira.

## Segurança

- não logar áudio, transcript completo ou token como diagnóstico;
- dedupe deve impedir processamento duplicado;
- falha de download/transcrição deve falhar com segurança;
- não alterar velocidade/voz/TTS por mudanças que tratem apenas roteamento texto × áudio;
- conteúdo crítico continua dependendo de backend/tools.

## Imagens e documentos

Receber imagem/documento não significa que a Lívia deve interpretar o conteúdo automaticamente. Visão deve ser adicionada apenas para casos de produto claramente definidos e com validação adequada.

## Regressões mínimas

- áudio curto;
- áudio com pergunta;
- áudio com agenda;
- áudio com pedido;
- áudio com cardápio → texto;
- áudio normal depois do cardápio → áudio novamente;
- áudio inaudível/falha;
- webhook duplicado;
- handoff;
- isolamento entre estabelecimentos.
