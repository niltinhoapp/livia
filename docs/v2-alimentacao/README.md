# Lívia Alimentação V2 — fonte de verdade

Frente dedicada à vertical de lanchonetes e restaurantes: atendimento e
pedido completo pelo WhatsApp, do primeiro "oi" até o pedido pago e
entregue à operação.

**Este arquivo é a fonte de verdade da V2.** Toda fase entregue atualiza
o estado aqui antes de ser considerada concluída. Decisão tomada em
conversa que não estiver registrada neste arquivo não existe.

- Última atualização: 2026-09-20
- Estado geral: **F1 e F2 concluídas, aguardando validação. Ainda sem
  push: o repositório não está autorizado para escrita nesta sessão (ver
  seção 8).**
- Anexos:
  [`ESTADO-ATUAL.md`](./ESTADO-ATUAL.md) — auditoria do que já existe
  (pronto / parcial / falta) e referência técnica da importação por visão;
  [`PROVEDORES-PAGAMENTO.md`](./PROVEDORES-PAGAMENTO.md) — pesquisa e
  matriz A/B/C de 14 provedores

---

## 1. Premissas aprovadas

Fixadas pelo dono do produto. Não se reabrem sem decisão explícita
registrada na seção 3.

1. A Lívia Alimentação V2 é uma frente separada da evolução normal da V1
   (agenda/serviços), que segue com o Codex. A V2 não refaz
   funcionalidade geral da V1 nem promove refatoração ampla fora do seu
   escopo.
2. Critério de lançamento: **"chegou, conectou, está pronto"** — ver
   seção 6.
3. **Pagamento é requisito de lançamento.** A vertical não é liberada
   comercialmente operando só com PIX manual.
4. A arquitetura de pagamentos é **neutra em relação ao provedor**: o
   núcleo do pedido e a IA não sabem qual provedor o estabelecimento usa.
5. O dinheiro da venda vai **direto para a conta do estabelecimento**. A
   Lívia/Conect Web não recebe para repassar.
6. O Asaas é o primeiro adapter, para provar a arquitetura — **desde que
   isso não acople o núcleo ao Asaas**. O contrato neutro nasce antes do
   adapter (F5 antes de F6), justamente para garantir isso.
7. Mercado Pago e PagBank permanecem no escopo de lançamento planejado.
8. O levantamento do processo de homologação do PagBank começa desde já,
   por depender de prazo externo — ver seção 5.
9. A importação de cardápio por visão é **separada da IA
   conversacional**. Visão serve à importação; o atendimento diário
   continua texto + áudio.
10. Na extração por visão, **precisão (sobretudo de preço) tem
    prioridade sobre economia de tokens**.
11. **Nada extraído de imagem entra no cardápio sem revisão e
    confirmação do comerciante.**
12. Regra dura de pagamento: só evento confiável do backend/provedor
    altera estado financeiro. A IA nunca considera pago por texto do
    cliente ou imagem de comprovante.
13. Trabalho em etapas pequenas e testáveis, sempre em branch separada.
    Sem merge automático. Sem alterar Production, Meta ou secrets. Sem
    usar dados reais sem autorização.

## 2. Arquitetura — regras que não se negociam

**Separação de domínios.** `lib/billing/` é e continua sendo a
assinatura do SaaS (o estabelecimento pagando a Lívia). O pagamento do
**pedido** nasce em namespace próprio (`lib/payments/`). Misturar os dois
é o erro mais caro desta frente.

**Porta única.** Todo provedor implementa o mesmo contrato:

```
PaymentProvider
  createCharge(ctx, input)    → { providerChargeId, status, pixCopyPaste?,
                                   pixQrCodeBase64?, checkoutUrl?, expiresAt }
  getCharge(ctx, chargeId)    → { status, paidAt?, amountCents }
  cancelCharge(ctx, chargeId) → { status }
  parseWebhook(raw, headers)  → { providerChargeId, status, eventId, occurredAt }
```

`status` é sempre do enum neutro (`pending | paid | expired | canceled |
refunded | failed`), nunca a string do provedor — traduzir é
responsabilidade do adapter, e é isso que mantém `lib/orders.ts` e a IA
ignorantes de quem processa.

**Credenciais.** Campo `payments: { provider, status, credentials
(cifradas), connectedAt, expiresAt }` no estabelecimento, reaproveitando
`lib/whatsapp/tokenCrypto.ts` em vez de criar um segundo mecanismo de
criptografia. Chave de API (Asaas) e par OAuth com refresh (Mercado Pago,
PagBank) cabem no mesmo formato.

**Webhook.** `app/api/webhooks/payments/[provider]/route.ts`, cada rota
delegando ao `parseWebhook` do adapter. O processamento copia o padrão
já validado em `lib/billing/asaasWebhookProcessing.ts` (idempotência por
id de evento, gravação atômica, evento fora de ordem ignorado).

**Trava de segurança.** Nenhuma tool de IA recebe permissão de escrita
no status de pagamento. `create_order_payment` não aceita valor como
parâmetro (usa o total do pedido calculado no backend);
`get_order_payment_status` é leitura pura, escopada ao telefone do
cliente.

**Estados do pedido.** `confirmed → awaiting_payment → paid → accepted →
preparing → …`, com "pagar na entrega" pulando direto para `accepted`. O
campo morto `awaiting_confirmation` é resolvido (reaproveitado ou
removido) na mesma passagem.

## 3. Log de decisões

Formato: o que foi decidido, quando, alternativas descartadas, motivo,
impacto.

### D1 — Começar pela F1, sequencial (2026-09-19)

Alternativas descartadas: F1 e F9 em paralelo; entrar direto no núcleo
de pagamentos (F5).

Motivo: as correções da F1 mexem na base que todas as fases seguintes
usam. Construir pagamento sobre um cardápio onde categoria desativada
ainda vende, ou taxa de bairro erra por acento, é assentar no chão
torto. Paralelizar F9 só rende depois da F3.

Impacto: ordem F1→F13 mantida integralmente.

### D2 — Documentação da V2 versionada no repositório (2026-09-19)

Alternativas descartadas: manter o plano fora do repositório; commitar
direto na `main`.

Motivo: o projeto já versiona documentação de arquitetura
(`docs/AUDITORIA-MESTRA-*`, `FOCO-OPERACIONAL.md`, `LIVIA-V2-ROADMAP.md`).
Documento que mora junto do código não diverge do que foi implementado, e
deixa o escopo da V2 visível para quem toca a V1 — sem invadir.

Impacto: branch `docs/v2-alimentacao`, sem merge automático. Cada fase
passa a atualizar este README como parte da entrega, não como tarefa
separada.

### D3 — Trilha externa: dono do produto conduz, Claude prepara (2026-09-19)

Alternativas descartadas: ficar só na documentação pública; adiar até a
F12.

Motivo: homologação do PagBank exige identidade jurídica da Conect Web —
só o dono do produto abre. O material técnico exigido no processo pode
ser preparado antes. A pergunta à InfinitePay é objetiva e a resposta
muda a classificação deles de B para A.

Impacto: ver seção 5 — o levantamento **corrigiu uma premissa minha
anterior** e reduziu o risco atribuído à F12.

## 4. Estado das 13 fases

| Fase | Entrega | Depende de | Risco | Estado |
|---|---|---|---|---|
| F0 | Auditoria, pesquisa de provedores, arquitetura e plano | — | — | **Concluída** |
| F1 | Correções de base: categoria desativada bloquear produtos; acento na taxa de bairro; desacoplar painel do toggle de IA; `evaluateTrust` considerar cardápio | — | Baixo | **Concluída** — ver 4.1 |
| F2 | Tela de configuração de pedido no painel (retirada/entrega, taxas, métodos aceitos, instruções PIX), consumindo a API existente | F1 | Baixo | **Concluída** — ver 4.2 |
| F3 | Conversa: tool de cardápio completo; `pixInstructions` chegando à Lívia; tom do prompt de pedido; perguntar em item ambíguo; destacar item repetido no resumo | F2 | Baixo | Pendente |
| F4 | Robustez: fallback determinístico no estouro do tool loop; `update_order_item` aceitar variação/adicional; resolver `awaiting_confirmation` | F3 | Médio | Pendente |
| F5 | **Núcleo de pagamentos**: contrato, status neutros, registry, credenciais cifradas, rota de webhook genérica, adapter falso para teste — sem provedor real | F4 | Médio | Pendente |
| F6 | **Adapter Asaas (pedido)** + tela "conectar pagamento" com chave do próprio comerciante | F5 | Médio | Pendente |
| F7 | **Fluxo conversacional de pagamento**: tools, estado `awaiting_payment → paid`, reconciliação por webhook, trava de nunca aprovar por comprovante | F6 | **Alto** | Pendente |
| F8 | **Adapter Mercado Pago** + OAuth (conectar, renovar, revogar) | F7 | Alto | Pendente |
| F9 | **Importação de cardápio por foto**: upload, visão, schema, validação, revisão com comparação atual × detectado, publicação | F3 | Médio | Pendente |
| F10 | Onboarding da vertical: trilha WhatsApp → cardápio → pagamento → operação, com o toggle de pedidos fora da aba Agenda | F6, F9 | Baixo | Pendente |
| F11 | Acompanhamento: notificação proativa de status ao cliente e `cancel_order` com trava de posse | F7 | Médio | Pendente |
| F12 | **Adapter PagBank** + homologação | F8 | Médio (revisado, ver seção 5) | Pendente |
| F13 | Medição de consumo de IA no gateway (base para Créditos) + observabilidade da vertical | F9 | Baixo | Pendente |

Ordem de execução: **F1 → F2 → F3 → F4 → F5 → F6 → F7 → F8 → F9 → F10 →
F11 → F12 → F13**, com F9 livre para ser antecipada em paralelo a
qualquer momento depois da F3, por não tocar pagamento nem o núcleo do
pedido.

### 4.1 F1 — o que mudou

Branch `feat/v2-f1-correcoes-base` (a partir de `docs/v2-alimentacao`, que
por sua vez sai de `main` `28a730a`). Sem merge.

**Categoria desativada agora bloqueia os produtos dela.** A regra mora em
`lib/orders.ts`: `categoryBlocksSale()` mais duas leituras filtradas
(`listAvailableMenuProducts`, `getAvailableMenuProduct`) que as
ferramentas da IA passaram a usar no lugar das listagens cruas. A trava é
aplicada na montagem (`addOrderItem`) e relida dentro da transação de
`confirmOrder`, para o caso de a categoria ser desativada entre o
rascunho e a confirmação. **Produto órfão** (categoria inexistente)
mantém o comportamento antigo de propósito: a correção não derruba item
de catálogo legado. O painel continua enxergando tudo — o comerciante
precisa ver o que está desligado para reativar.

**Taxa de entrega por bairro parou de errar em silêncio.** A comparação
passa por `neighborhoodKey()`, que remove acento, normaliza espaço e
caixa dos dois lados. "Jardim América" cadastrado agora casa com "jardim
america" dito no WhatsApp, em vez de cair na regra fixa cobrando outro
valor.

**Painel desacoplado do interruptor da IA.** `bot.ordersEnabled` passa a
controlar só o que a IA faz na conversa. As rotas de gestão e de
configuração (`/api/orders`, `/api/orders/[id]`, `/api/orders/settings`,
`/api/menu/*`) não retornam mais 404 quando ele está desligado; a
listagem devolve `ordersEnabled` junto, e a tela troca o bloqueio de
página inteira por um aviso no topo. Decisão de escopo: as rotas de
cardápio e de settings foram incluídas junto das de pedido porque a tela
consome as três — soltar só uma deixaria o painel em estado de erro — e
porque cadastrar cardápio antes de ligar o atendimento é o caminho
previsto em "chegou, conectou, está pronto".

**`evaluateTrust` reconhece o cardápio como fonte de preço.** Com
`ordersEnabled`, a intenção `ask_price` não injeta mais a diretiva de
"nenhum preço cadastrado, ofereça transferir" — que contradizia, no mesmo
prompt, a instrução de consultar `search_menu`. Horário e endereço seguem
dependendo da base de conhecimento, sem mudança.

Testes: 1839 passando (eram 1820 na base), 19 novos em
`lib/orders.categoryAvailability.test.ts`, `lib/orders.test.ts`,
`lib/ai/trustPolicy.test.ts`, `app/api/orders/route.test.ts` e
`app/api/orders/[id]/route.test.ts`. `tsc --noEmit` limpo.

Custo conhecido: `addOrderItem` faz uma leitura extra de documento
(categoria) por item adicionado, e `confirmOrder` uma por item na
transação.

### 4.2 F2 — o que mudou

Branch `feat/v2-f2-config-pedidos`, a partir de `feat/v2-f1-correcoes-base`.
Sem merge.

A API `/api/orders/settings` existia desde o MVP e **nenhuma tela a
consumia**: o estabelecimento ficava preso no padrão (só retirada, entrega
desligada, taxa R$ 0, todos os métodos aceitos, sem chave PIX), e só dava
pra mudar chamando a API na mão. A F2 é a interface que faltava — sem
nenhuma regra nova de domínio e sem tocar em contrato de backend.

Novo componente `app/painel/pedidos/OrderSettingsEditor.tsx`, montado numa
seção "Operação" na própria tela de Pedidos (a página em si mudou em 3
linhas). Cobre: retirada e entrega; taxa padrão e taxa por bairro, com
adicionar e remover; formas de pagamento aceitas; e instruções de PIX,
que só aparecem quando PIX está entre as formas aceitas.

Duas decisões que valem registro:

A **taxa padrão é opcional e explícita**. No backend, a regra `fixed` é o
fallback para bairro não listado; deixar de enviá-la faz a Livia recusar
endereço fora da lista em vez de chutar um valor. Em vez de esconder isso,
a tela expõe como escolha ("Cobrar uma taxa padrão"), com o efeito
descrito em texto.

As **travas são de formulário, não de domínio**. A tela recusa salvar sem
retirada nem entrega, sem nenhuma forma de pagamento, com taxa inválida,
ou com entrega ligada e nenhuma taxa configurada — situações em que o
estabelecimento ficaria impossibilitado de fechar pedido. Quem valida o
dado de verdade continua sendo `normalizeOrderSettings`; nada foi
adicionado lá.

O campo `pixInstructions` passa a ser preenchível, mas **ainda não chega
à Livia** — isso é F3. O texto na tela diz isso ao comerciante, junto do
aviso de que a confirmação de pagamento continua sendo dele.

Testes: 1853 passando (1839 ao fim da F1), 14 novos em
`app/painel/pedidos/OrderSettingsEditor.test.tsx` cobrindo a conversão de
ida e volta entre `OrderSettings` e formulário, as quatro travas e o
comportamento de carregar/salvar. Usei `fireEvent` em vez de
`@testing-library/user-event` para não adicionar dependência ao projeto.
`tsc --noEmit` limpo.

---

## 5. Trilha externa (PagBank e InfinitePay)

### PagBank — correção de premissa

A premissa 8 dizia "iniciar já a homologação porque depende de prazo
externo". O levantamento na documentação oficial mostrou que **a
homologação não é uma fila que dá para entrar antes do
desenvolvimento**:

- O processo é **obrigatório** para todo integrador direto de API, e
  plataformas **devem obrigatoriamente usar a API Connect**, por
  operarem em nome de terceiros.
- A solicitação é feita por formulário (Pipefy), e exige **envio de
  logs de requisição/resposta de sandbox e produção** — ou seja,
  **pressupõe uma integração já funcionando em sandbox**.
- Exige medidas adicionais de segurança, como reCaptcha nas páginas de
  checkout.
- SLA de **até 4 dias úteis**, desde que os logs sejam enviados
  corretamente.

Consequência prática, e é boa notícia: o prazo externo é curto (4 dias
úteis), não semanas. O risco da F12 cai de **Alto** para **Médio**. O que
faz sentido antecipar agora não é a homologação em si, e sim: criar a
conta PagBank sandbox, registrar a aplicação Connect e obter as
credenciais de aplicação. A homologação se solicita quando a F12 estiver
rodando em sandbox.

**Tarefa do dono do produto:** criar a conta PagBank e registrar a
aplicação Connect (precisa de identidade jurídica da Conect Web).
**Tarefa do Claude:** preparar, na F12, o pacote de logs e a descrição
técnica da integração no formato que o formulário pede.

### InfinitePay — pergunta objetiva

A documentação pública indica o handle (InfiniteTag) como identificador
na criação de links de checkout, sem segredo por lojista nem OAuth. Isso
os mantém em classe B. Pergunta a fazer ao suporte/comercial deles:

> "Existe credencial autenticada por lojista (API key, token ou OAuth)
> para uma plataforma criar cobranças em nome de contas InfinitePay de
> terceiros, ou o handle público é o único identificador? Existe
> programa de parceria para plataformas?"

Se a resposta for que existe credencial autenticada, a InfinitePay sobe
para classe A e entra como candidata logo após a F8, à frente de Cielo e
Efí — sem alterar F1 a F7.

## 6. Critério de lançamento

Um estabelecimento novo deve conseguir, **sozinho e sem acionar
suporte**:

entrar → conectar o WhatsApp → cadastrar ou importar o cardápio →
conectar um provedor de pagamento suportado → configurar retirada/entrega,
taxa e formas de pagamento → receber um pedido real completo, com
cobrança gerada, pagamento confirmado pelo backend e pedido entregue à
operação.

Enquanto qualquer passo exigir intervenção nossa, a vertical não é
liberada comercialmente.

## 7. Como manter este documento

- Toda fase concluída atualiza a tabela da seção 4 antes de ser
  considerada entregue.
- Toda decisão que mude rumo entra na seção 3, com alternativa
  descartada e motivo — inclusive quando corrigir algo que já estava
  escrito aqui (ver seção 5 como exemplo).
- Premissa só sai da seção 1 por decisão explícita registrada na seção 3.

---

## 8. Pendência aberta: escrita no repositório

As branches da V2 existem e estão commitadas, mas **ainda não subiram**.
O proxy da sessão recusa `git push` com "não está no conjunto de
repositórios autorizados"; leitura (`clone`, `fetch`) funciona
normalmente, então a base segue sendo acompanhada.

O que foi verificado na documentação oficial: a integração de GitHub do
Claude é **somente leitura** (sincroniza arquivos para chat e Projects,
não concede push), e não existe no Cowork controle para adicionar um
repositório ao conjunto autorizado do proxy — há issue aberta no
repositório do Claude Code relatando exatamente esta mensagem de erro.
Ou seja: não é configuração que o dono do produto tenha deixado de
fazer.

Enquanto isso:

- cada fase é entregue também como patch (`git format-patch`), aplicável
  com `git am`, para que nenhum trabalho dependa da vida deste container;
- a alternativa definitiva em avaliação é vincular a sessão ao computador
  do dono do produto pelo app de desktop, e empurrar de lá com as
  credenciais dele;
- nenhum commit é recriado ou reescrito enquanto isso não se resolve.

Branches locais, em ordem:

| Branch | Commit | Conteúdo |
|---|---|---|
| `docs/v2-alimentacao` | `fb6091a` | Documentação da V2 |
| `feat/v2-f1-correcoes-base` | `025ecb6` | F1 |
| `feat/v2-f2-config-pedidos` | (este) | F2 |
