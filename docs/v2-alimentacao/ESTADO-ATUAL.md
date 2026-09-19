# Estado atual da vertical alimentação — auditoria

Anexo da [fonte de verdade da V2](./README.md). Auditoria de leitura pura
do que o Codex já construiu, feita em `main` `28a730a` (2026-09-19).
Serve de referência para as fases F1 a F4 e F9.

Regra que orientou a auditoria: **aproveitar o que existe.** Nada aqui
recomenda recriar algo que já funciona.

---

## 1. Pronto — reutilizar integralmente

| Capacidade | Onde | Situação |
|---|---|---|
| Cardápio estruturado (categoria, produto, variação de tamanho, grupo de adicionais com min/máx) | `types/index.ts`, `app/api/menu/*` | Completo e validado |
| Preço obrigatório e validado no cadastro | `lib/orders.ts` (`normalizeProduct`) | Completo |
| Carrinho persistido por telefone, sobrevive entre mensagens | `lib/orders.ts` (`draftFor`/`mutateDraft`) | Completo, transação Firestore real |
| Vários itens, quantidade, variação, adicionais, observação por item | `lib/ai/tools.ts` (`add_order_item`) | Completo |
| Cálculo de subtotal/taxa/total sempre no backend | `lib/orders.ts` (`calculateItem`, `recalculate`) | Completo |
| Revalidação do catálogo dentro da transação de confirmação | `lib/orders.ts` (`confirmOrder`) | Completo — rejeita se preço/produto mudou |
| Produto indisponível bloqueado na montagem e na confirmação | `lib/orders.ts`, `lib/ai/tools.ts` | Completo (categoria inativa não — ver seção 2) |
| Idempotência por `operationId` do tool call | `lib/orders.ts`, `lib/ai/orderOperationId.test.ts` | Completo, testado sob concorrência |
| Dedupe de mensagem repetida do WhatsApp (`wamid`) | `app/api/webhooks/whatsapp/route.ts`, `lib/repo.dedupe.test.ts` | Completo, atômico |
| Isolamento entre estabelecimentos e entre conversas | `lib/orders.concurrency.test.ts` | Completo, testado |
| Trava de posse por telefone (`confirm_order`, `get_order_status`) | `lib/ai/tools.ts` | Completo |
| Teto de mutações de pedido por turno (8) | `lib/ai/brain.ts` | Completo |
| Painel: fila, itens, total, transições de status, cancelar | `app/painel/pedidos/page.tsx`, `app/api/orders/*` | Completo e responsivo |
| Handoff humano | `lib/ai/tools.ts`, `lib/ai/humanRequest.ts` | Completo (genérico, serve à vertical) |
| Recebimento e armazenamento de imagem/documento do WhatsApp | `lib/whatsapp/inboundMessage.ts`, `lib/attachments/storage.ts` | Completo — reutilizável na F9 |
| Multimodalidade já existente: transcrição de áudio | `lib/ai/transcription.ts` | Completo — precedente para visão |
| Ponto único de chamada ao modelo | `lib/ai/gateway.ts` | Completo — onde visão e medição se encaixam |
| Compatibilidade com GPT-5.6 Terra | `lib/ai/openaiCompatibility.ts` | Completo |
| Cliente Asaas + webhook atômico/idempotente + state machine | `lib/billing/*`, `app/api/webhooks/asaas/route.ts` | Completo — **mas é assinatura do SaaS, não do pedido** |
| Criptografia de token de terceiros | `lib/whatsapp/tokenCrypto.ts` | Completo — reutilizável na F5 |

## 2. Parcialmente pronto — completar, não recriar

| Item | O que existe | O que falta | Fase |
|---|---|---|---|
| Configuração de pedido (entrega, taxa, métodos, PIX) | API completa (`app/api/orders/settings/route.ts`) | Nenhuma tela do painel chama — estabelecimento travado no padrão (só retirada) | F2 |
| `pixInstructions` | Campo persistido e validado | Nunca chega ao prompt nem a tool nenhuma | F3 |
| Disponibilidade por categoria | `category.active` existe e é editável | Não bloqueia os produtos da categoria | F1 |
| Taxa de entrega por bairro | Regras por bairro + fallback fixo | Comparação sem normalizar acento → cobra errado em silêncio | F1 |
| Consulta ao cardápio pela IA | `search_menu`, `get_menu_product` | Sem "listar cardápio completo" | F3 |
| Edição de item já no carrinho | `update_order_item` (quantidade, observação) | Não aceita variação nem adicional | F4 |
| Estouro do tool loop (4 iterações) | Fallback existe para agenda | Sem equivalente para pedido — carrinho pela metade vira handoff | F4 |
| Estados do pedido | Enum completo | `awaiting_confirmation` morto; nenhum estado de pagamento | F4 / F7 |
| Naturalidade da conversa de pedido | Regras corretas e seguras | Bloco procedural, sem orientação de tom | F3 |
| Política de confiança em preço (`evaluateTrust`) | Funciona para base de conhecimento | Ignora o cardápio — pode recusar preço que saberia responder | F1 |
| Acesso ao painel de pedidos | Funciona | Gateado pelo mesmo flag que liga a IA | F1 |

## 3. Falta por completo

| Item | Fase |
|---|---|
| Pagamento do pedido (provedor, credenciais, cobrança, webhook, conciliação, estados). Confirmado por histórico: só 5 commits tocaram `lib/orders.ts` em toda a história do repo, nenhum sobre pagamento | F5–F8, F12 |
| Importação de cardápio por foto/PDF (upload, visão, parser, revisão) | F9 |
| Notificação proativa de status ao cliente | F11 |
| Cancelamento do pedido pelo cliente no WhatsApp | F11 |
| Onboarding da vertical alimentação | F10 |
| Medição de consumo de IA / créditos | F13 |

---

## 4. Referência técnica para a F9 (importação por visão)

### Situação verificada

- Modelo: chamada única centralizada em `lib/ai/gateway.ts`, com
  `LIVIA_MODEL` (padrão `gpt-4o-mini`), e compatibilidade já resolvida
  para GPT-5.6 Terra (`max_completion_tokens`, `reasoning_effort:
  "none"`). Trocar ou rotear modelo é barato.
- Multimodalidade existente: **áudio** (`lib/ai/transcription.ts`).
  **Visão não existe** — imagem do cliente vira o texto "[Imagem
  recebida]" e é arquivada.
- Armazenamento de arquivo: existe e aceita `image/jpeg`, `image/png`,
  `application/pdf` (`lib/attachments/storage.ts`).

Isso sustenta a premissa 9: visão entra como capacidade separada de
importação; o atendimento diário segue texto + áudio.

### Custo (tabela oficial de 2026-09-19)

Imagens são cobradas como tokens de entrada. Foto de celular em detalhe
alto fica na ordem de 1.000–1.500 tokens; em detalhe baixo, ~260. Com
prompt de extração e JSON de saída de um cardápio real, cada foto fica
perto de 2k tokens de entrada e 2k de saída.

| Fotos | GPT-5.6 Luna ($0,20 / $1,20 por 1M) | GPT-5.6 Terra ($2 / $12 por 1M) |
|---|---|---|
| 1 | ~US$ 0,003 | ~US$ 0,03 |
| 5 | ~US$ 0,01 | ~US$ 0,09 |
| 10 | ~US$ 0,015 | ~US$ 0,15 |

O custo é irrelevante nos dois casos — centavos de dólar por
estabelecimento, uma vez na vida. Pela premissa 10, a escolha é por
acerto no preço lido: **Terra para importação**, medindo os dois com
cardápios reais antes de fixar. O modelo do atendimento não muda.

### Schema estruturado de saída

JSON fechado, validado antes de qualquer gravação:

```
categorias[]
  nome
  produtos[]
    nome
    descricao?
    precoCentavos | null
    confianca: "alta" | "media" | "baixa"
    variacoes[]?  { nome, precoCentavos | delta, confianca }
    adicionais[]? { grupo, nome, precoCentavos, confianca }
    origem: { arquivo, pagina? }
```

Validação determinística do nosso lado, nunca do modelo: preço nulo ou
de confiança baixa **nunca** é publicado — vai para a revisão marcado
como pendente; preço fora de faixa plausível é sinalizado; produto sem
categoria cai em "Sem categoria"; a publicação passa pela mesma
`normalizeProduct` do cadastro manual, para que produto importado e
produto digitado obedeçam às mesmas regras.

Casos cobertos por desenho: várias fotos numa sessão; produto repetido em
fotos diferentes (dedupe por nome normalizado dentro do rascunho);
imagem ruim ou ilegível (item marcado, nunca descartado em silêncio);
preço duvidoso; produto sem preço; reprocessamento da mesma imagem (hash
do arquivo, não duplica o rascunho).

### Correspondência com produto existente

Nunca alterar nem duplicar automaticamente (premissa 11). Ao encontrar
nome equivalente (comparação normalizada, sem acento nem caixa), a
revisão mostra **produto atual × produto detectado**, com diferenças de
preço e composição destacadas, e três ações explícitas: **Atualizar**,
**Manter os dois**, **Ignorar**. Sem ação escolhida, nada acontece.

Botão em **Pedidos → Cardápio**.

### Medição de consumo (base da F13)

Não existe contabilização hoje. Como toda chamada ao modelo já passa por
`lib/ai/gateway.ts`, é lá que se registra por chamada: estabelecimento,
finalidade (`reception`, `summary` e o novo `menu_import`), modelo,
tokens de entrada/saída e custo calculado. O `AiPurpose` já existe no
gateway como "fundação para telemetria futura" — basta passar a gravar.
Créditos de IA vira depois uma leitura desse registro, não uma
refatoração.
