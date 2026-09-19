# Provedores de pagamento — pesquisa e matriz A/B/C

Anexo da [fonte de verdade da V2](./README.md). Pesquisa feita em
documentação oficial dos provedores (fontes no fim). Data: 2026-09-19.

Critério que orientou a leitura: **ter API não significa permitir que uma
plataforma opere em nome da conta de um terceiro.** Para cada provedor, a
pergunta foi: o comerciante conecta a conta que ele **já tem**, e o
dinheiro cai direto nela?

## Três modelos encontrados

1. **OAuth/Connect** — a plataforma redireciona, o comerciante autoriza,
   a plataforma recebe um token para operar naquela conta. Um clique para
   o comerciante. (Mercado Pago, PagBank, SumUp, Stripe Connect)
2. **Credencial do próprio comerciante** — ele gera a chave no painel
   dele e cola na Lívia. Funciona com conta existente, mas exige que ele
   ache e copie a credencial. (Asaas, Woovi, Efí, Banco Inter, Cielo,
   InfinitePay)
3. **Marketplace/subconta** — a plataforma cria estrutura nova por
   comerciante e normalmente entra no fluxo do dinheiro. Contraria a
   premissa 5 da V2. (Pagar.me, Iugu, Asaas white-label, Woovi parceiro)

## Matriz

| Provedor | Conecta conta existente | OAuth/Connect | Credencial manual | Exige subconta | Exige marketplace | PIX | Cartão/checkout | Webhook | Dinheiro direto ao lojista | Homologação | Complexidade | Classe |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Mercado Pago** | Sim | Sim (authorization_code, PKCE) | Não | Não | Não (`marketplace_fee` pode ser 0) | Sim | Sim | Sim | Sim | Não evidenciada | Média | **A** |
| **PagBank** | Sim (Connect) | Sim (autorização ou SMS) | Não | Não | Não | Sim | Sim | Sim | Provável (não confirmado em doc pública) | **Sim, obrigatória** | Média | **A** |
| **Asaas** | Sim (API key da conta dele) | Não | Sim | Não (no modo simples) | Não | Sim | Sim (link) | Sim | Sim | Só no white-label | **Baixa** (cliente já existe no repo) | **A** |
| **InfinitePay** | Sim (handle/InfiniteTag) | Não | Sim (handle) | Não | Não | Sim | Sim | Sim | Sim | Não evidenciada | Baixa | **B** |
| **Woovi / OpenPix** | Parcial (chave da conta dele) | Não | Sim | No modo parceiro, sim | Não | Sim | Limitado | Sim | Sim | Sim, no modo parceiro | Baixa/Média | **B** |
| **Efí (Gerencianet)** | Sim | Não (OAuth só client-credentials da própria app) | Sim + **certificado P12** | Não | Não | Sim | Sim | Sim | Sim | Não | **Alta** (mTLS por lojista) | **B** |
| **Banco Inter** | Sim (conta PJ dele) | Não | Sim + **certificado mTLS** | Não | Não | Sim | Não (PIX/boleto) | Sim | Sim | Não | **Alta** | **B** |
| **Cielo** | Sim (MerchantId/Key) | Não | Sim | Não | Não | Sim | Sim | Sim | Sim | Credenciamento Cielo | Média | **B** |
| **Pagar.me** | Não (recebedores criados pela plataforma) | Não | — | **Sim** | **Sim** | Sim | Sim | Sim | Via split | Sim (comercial) | Alta | **B** |
| **Iugu** | Não (subcontas) | Não | — | **Sim** | **Sim** | Sim | Sim | Sim | Via subconta | Sim (comercial) | Alta | **B** |
| **Stripe** | Sim (Connect) | Sim | Não | Não | Não | **PIX BR é "invite only"**; fora do BR incide IOF de 3,5% via Ebanx | Sim | Sim | Sim | Sim (convite) | Média | **C** |
| **SumUp** | Sim | Sim (OAuth 2.0 multi-merchant) | Não | Não | Não | **Sem evidência de PIX online no Brasil** | Sim | Sim | Sim | Provável | Média | **C** |
| **PicPay Empresas** | Não confirmado | Não evidenciado | Sim | Não confirmado | Não | Sim | Sim | Citado | Sim | Contrato comercial | Média | **C** |
| **Stone / Ton** | Não, para cobrança online de terceiros | Não | — | — | — | Sim (conta própria) | Maquininha/POS | Sim | Sim | Comercial | Alta | **C** |

**A** — adequado para conectar conta existente do estabelecimento.
**B** — possível, mas exige marketplace, subconta, onboarding especial,
certificado ou processo comercial.
**C** — inadequado para o nosso modelo hoje.

## Os três escolhidos

### Mercado Pago — classe A

OAuth `authorization_code` com PKCE opcional, desenhado para conectar a
conta existente de um vendedor a uma plataforma terceira. Access token
vale **180 dias**, com refresh token; o código de autorização vale 10
minutos; há endpoint de revogação. A documentação de split é explícita:
usa-se **um access token por vendedor obtido via OAuth**, e a comissão da
plataforma (`marketplace_fee` / `application_fee`) **pode ser zero** —
dá para processar em nome do vendedor sem virar marketplace, com o
dinheiro indo para a conta dele, descontada só a taxa do próprio Mercado
Pago. PIX via `/v1/orders` retorna `qr_code`, `qr_code_base64` e
`ticket_url`, expiração configurável de 30 minutos a 30 dias, confirmação
por webhook/IPN. Não há exigência documentada de aprovação comercial
prévia para usar OAuth.

Limitações: token de 180 dias exige rotina de renovação e tratamento de
revogação pelo lojista; a taxa do MP incide antes do repasse.

### Asaas — classe A, e o de menor custo para nós

O comerciante que já tem conta gera a própria API key no painel e cola na
Lívia; autenticação por chave de conta, sem OAuth. A API cobre PIX (QR
dinâmico), link de pagamento e webhooks. O modo white-label/subcontas
existe mas **exige alinhamento prévio com gerente de contas** — e não
precisamos dele: no modo "chave do próprio comerciante", a conta e o
dinheiro são dele.

Entra primeiro porque o repositório **já tem** cliente Asaas, webhook
atômico e idempotente e state machine (construídos para a assinatura do
SaaS). O padrão — e parte do código — é reaproveitável, o que faz deste o
adapter mais barato para validar a camada nova ponta a ponta.

Limitações: credencial colada à mão (mais fricção que OAuth); a chave dá
acesso amplo à conta do lojista, exigindo guarda cifrada e discurso claro
no onboarding.

### PagBank — classe A, com processo obrigatório

O Connect permite executar ações em nome de usuários PagBank, vinculando
contas existentes, por redirecionamento ou SMS. Token com validade,
refresh rotacionado a cada renovação (o anterior é invalidado) e endpoint
de revogação. A API de Orders cobre PIX com QR code, crédito, débito com
3DS, boleto e carteira, com webhooks de mudança de status.

**Homologação é obrigatória** e plataformas **devem** usar a API Connect.
O processo exige logs de sandbox e produção — ou seja, pressupõe
integração já funcionando — é feito por formulário, e tem SLA de até 4
dias úteis. Detalhe operacional na [seção 5 do README](./README.md#5-trilha-externa-pagbank-e-infinitepay).

Limitações: o Connect via SMS só cria transações e consulta (sem estorno
nem dados cadastrais); a documentação pública não detalha validade exata
dos tokens nem o fluxo de liquidação — confirmar na homologação.

## Por que os outros ficaram fora da primeira versão

- **InfinitePay (B):** API simples, PIX e cartão, webhook de aprovação, e
  enorme entre pequenos comerciantes. Trava na autenticação: a doc
  pública indica o handle como identificador, sem segredo por lojista.
  Candidata número 1 da segunda leva, dependendo da resposta deles.
- **Efí e Banco Inter (B):** sólidos e muito usados, mas exigem
  **certificado mTLS por lojista**. Pedir a um dono de lanchonete que
  gere e suba um `.p12` quebra o "chegou, conectou, está pronto".
- **Cielo (B):** credenciais coladas à mão, foco em cartão,
  credenciamento próprio. Viável, sem vantagem sobre os três de cima.
- **Pagar.me e Iugu (B):** exigem recebedores/subcontas e arquitetura de
  marketplace — colocam a plataforma no fluxo do dinheiro, contra a
  premissa 5.
- **Stripe (C):** PIX no Brasil é **invite only** e, para conta fora do
  BR, entra IOF de 3,5% via Ebanx. Inviável para o público-alvo.
- **SumUp (C):** tem OAuth multi-merchant, mas sem evidência documental
  de PIX online por API no Brasil.
- **PicPay (C) e Stone/Ton (C):** documentação pública não confirma
  conexão de conta de terceiro por plataforma; dependem de contrato.

## Ordem recomendada

**Asaas (F6) → Mercado Pago (F8) → PagBank (F12).** Asaas primeiro não
por ser o melhor, mas por ser onde o erro é mais barato e o
reaproveitamento maior. Mercado Pago em seguida pela cobertura e pelo
melhor modelo de conexão. PagBank por último dos três pelo processo
obrigatório de homologação, que pressupõe sandbox funcionando.

## Fontes

- Mercado Pago — OAuth (criação, boas práticas, gerenciamento):
  https://www.mercadopago.com.br/developers/pt/docs/security/oauth/creation
- Mercado Pago — integração marketplace/split:
  https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/integration-configuration/integrate-marketplace
- Mercado Pago — PIX via Checkout API Orders:
  https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/pix
- PagBank — Connect: https://developer.pagbank.com.br/docs/connect
- PagBank — Modelo de Aplicações:
  https://developer.pagbank.com.br/v1/reference/aplicacoes-utilizando-as-apis
- PagBank — Pedidos e pagamentos (Order):
  https://developer.pagbank.com.br/docs/pedidos-e-pagamentos-order
- PagBank — Primeiros passos (plataformas devem usar Connect):
  https://developer.pagbank.com.br/docs/primeiros-passos
- PagBank — Solicitar homologação (formulário, logs, SLA 4 dias úteis):
  https://developer.pagbank.com.br/docs/solicitar-homologacao
- Asaas — visão geral, chaves de API e webhooks:
  https://docs.asaas.com/docs/visao-geral
- Asaas — white label e subcontas:
  https://docs.asaas.com/docs/about-white-label
- Stripe — PIX (disponibilidade no Brasil, Connect, IOF):
  https://docs.stripe.com/payments/pix
- Woovi/OpenPix — integração como parceiro:
  https://developers.openpix.com.br/en/docs/partnerships/how-to-integrate-as-woovi-partner
- Efí — credenciais e certificado da API PIX:
  https://dev.efipay.com.br/en/docs/api-pix/credenciais/
- InfinitePay — documentação do checkout:
  https://www.infinitepay.io/checkout-documentacao
- Iugu — subcontas: https://dev.iugu.com/reference/criar-subconta
- Cielo — credenciais MerchantId/MerchantKey:
  https://docs.cielo.com.br/ecommerce-cielo/reference/visualizar-as-credenciais-merchantid-e-merchantkey
- Cielo Conecta:
  https://desenvolvedores.cielo.com.br/api-portal/pt-br/content/cielo-conecta
- Pagar.me — recebedores:
  https://docs.pagar.me/v1/docs/criando-um-recebedor-1
- Banco Inter — API Cobrança/PIX:
  https://developers.inter.co/references/cobranca-bolepix
- SumUp — autorização/OAuth:
  https://developer.sumup.com/tools/authorization
- PicPay Empresas — cobrança PIX:
  https://developers-business.picpay.com/checkout/docs/api/charge-pix
