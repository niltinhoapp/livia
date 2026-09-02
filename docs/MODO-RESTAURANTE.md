# Lívia — Modo Restaurante

## Visão geral

A Lívia poderá atender restaurantes usando o mesmo núcleo atual de IA + WhatsApp, adicionando um perfil de negócio específico para alimentação.

A proposta inicial não é competir com iFood nem criar um PDV completo. A primeira versão deve transformar a Lívia em uma **atendente inteligente de pedidos pelo WhatsApp**, capaz de conhecer o cardápio do estabelecimento, tirar dúvidas e montar pedidos com segurança.

> Proposta de valor: **Envie seu cardápio e a Lívia aprende a vender por ele.**

## Objetivo da V1

Permitir que um restaurante configure a Lívia para:

- responder dúvidas sobre o estabelecimento;
- informar horários de funcionamento;
- informar endereço e regras de atendimento;
- consultar o cardápio;
- responder preços, sabores, tamanhos e ingredientes;
- informar adicionais e complementos;
- montar um pedido durante a conversa;
- oferecer itens adicionais quando fizer sentido;
- identificar se o pedido é para entrega ou retirada;
- coletar endereço para delivery;
- perguntar a forma de pagamento;
- apresentar um resumo antes da confirmação;
- encaminhar o pedido organizado ao restaurante;
- transferir a conversa para atendimento humano quando necessário.

## Segmentos no onboarding

A arquitetura deve permitir que o estabelecimento escolha seu tipo de negócio durante o onboarding.

Exemplos:

- Clínica
- Salão
- Pet Shop
- Restaurante

Ao selecionar **Restaurante**, a Lívia habilita configurações específicas desse segmento.

## Configurações do restaurante

Inicialmente:

- nome do restaurante;
- horário de funcionamento;
- endereço;
- telefone;
- retirada no local: sim/não;
- delivery: sim/não;
- regiões atendidas;
- taxa de entrega;
- pedido mínimo, se houver;
- formas de pagamento;
- observações gerais;
- regras específicas do estabelecimento.

## Cardápio

O cardápio será uma das partes centrais do modo Restaurante.

### Formas de entrada desejadas

O restaurante poderá fornecer o cardápio por:

1. PDF;
2. imagem ou foto;
3. texto colado;
4. link de cardápio/site;
5. cadastro manual.

### Processamento com IA

Ao receber o cardápio, a IA deve extrair e organizar informações como:

- categorias;
- produtos;
- descrições;
- preços;
- tamanhos;
- sabores;
- ingredientes;
- adicionais;
- complementos;
- variações.

Exemplo de entrada:

```text
PIZZAS
Calabresa grande ........ R$ 45,00
Mussarela grande ........ R$ 42,00
Borda recheada .......... + R$ 8,00

BEBIDAS
Coca-Cola 2L ............ R$ 12,00
```

Estrutura esperada:

```text
Categoria: Pizzas
- Calabresa | Grande | R$ 45,00
- Mussarela | Grande | R$ 42,00
- Borda recheada | adicional | R$ 8,00

Categoria: Bebidas
- Coca-Cola | 2L | R$ 12,00
```

## Revisão antes da publicação

A IA não deve publicar automaticamente o resultado da leitura do cardápio.

Fluxo recomendado:

**Enviar cardápio → IA interpreta → Revisar cardápio → Corrigir se necessário → Publicar**

Isso reduz o risco de um preço, tamanho ou produto ser interpretado incorretamente.

## Armazenamento estruturado

O cardápio não deve existir apenas como um grande texto dentro do prompt da IA.

Os produtos devem ser armazenados de forma estruturada no banco de dados.

Estrutura conceitual inicial:

```text
restaurantMenu
  categories
    id
    name
    order

  products
    id
    categoryId
    name
    description
    active

  variants
    id
    productId
    name
    price

  addons
    id
    productId/categoryId
    name
    price
    active
```

Isso permitirá posteriormente:

- editar preços sem reenviar o cardápio;
- marcar item como indisponível;
- criar promoções;
- controlar adicionais;
- atualizar produtos;
- calcular pedidos corretamente;
- gerar relatórios.

## Regra importante para a IA

A Lívia não deve inventar produtos, preços, ingredientes ou disponibilidade.

Para informações comerciais do cardápio, a fonte de verdade deve ser o banco de dados do restaurante.

Quando não encontrar uma informação confiável, deve informar que não possui aquela informação e, quando apropriado, transferir para atendimento humano.

## Fluxo básico de pedido

Exemplo:

**Cliente:** Quero pedir uma pizza.

**Lívia:** Claro! Qual sabor você gostaria?

**Cliente:** Calabresa grande.

**Lívia:** Perfeito. Quer adicionar alguma bebida?

**Cliente:** Coca 2L.

**Lívia:** Seu pedido ficou com uma pizza grande de calabresa e uma Coca-Cola 2L. É para entrega ou retirada?

Se entrega:

1. coletar endereço;
2. verificar regra/região de entrega;
3. informar taxa quando aplicável;
4. perguntar forma de pagamento;
5. apresentar resumo e total;
6. solicitar confirmação;
7. encaminhar pedido ao restaurante.

## Estado do pedido durante a conversa

O pedido deve ser mantido de forma estruturada durante a conversa, e não somente inferido do histórico textual.

Exemplo conceitual:

```text
orderDraft
  contactPhone
  customerName
  items[]
  subtotal
  deliveryType
  deliveryAddress
  deliveryFee
  total
  paymentMethod
  notes
  status
```

Estados iniciais possíveis:

- building
- awaiting_address
- awaiting_payment_method
- awaiting_confirmation
- confirmed
- handed_off
- cancelled

## Handoff humano

O modo Restaurante deve reutilizar o handoff humano já existente na Lívia.

Casos recomendados para handoff:

- cliente pede um atendente;
- informação não existe no cardápio/base;
- pedido possui exceção não suportada;
- dúvida sobre alergia ou informação sensível sem dado confiável;
- problema com pagamento;
- reclamação;
- alteração de pedido já confirmado.

## Fora do escopo da V1

Evitar inicialmente:

- construir PDV completo;
- logística própria avançada;
- marketplace;
- sistema semelhante ao iFood;
- gestão completa de estoque;
- integrações complexas com dezenas de ERPs.

Essas funções podem ser avaliadas depois da validação comercial do modo Restaurante.

## Evoluções futuras

Depois da V1 validada:

- Pix integrado;
- link de pagamento;
- acompanhamento de status do pedido;
- integração com impressora/cozinha;
- integração com PDV/ERP;
- cupons;
- promoções automáticas;
- recompra;
- recuperação de clientes;
- campanhas pelo WhatsApp;
- programa de fidelidade;
- relatórios de produtos mais pedidos;
- ticket médio;
- sugestões inteligentes de upsell;
- cardápio por horário/dia;
- itens temporariamente indisponíveis.

## Relação com a análise da Meta

O desenvolvimento do modo Restaurante é uma evolução interna da Lívia e pode ser planejado/desenvolvido enquanto a configuração atual do WhatsApp/Meta está em análise.

Durante a revisão, deve-se evitar alterar desnecessariamente a configuração do app Meta que foi submetida. O desenvolvimento do modelo de dados, interface, cardápio e lógica interna pode seguir independentemente.

## Princípio de arquitetura

A Lívia deve continuar sendo **um único produto**, com um núcleo compartilhado de:

- WhatsApp;
- IA;
- conversas;
- conhecimento;
- handoff humano;
- autenticação;
- multi-tenant.

Cada segmento adiciona ferramentas e regras próprias.

```text
Lívia Core
├── WhatsApp
├── IA
├── Conversas
├── Handoff
├── Autenticação
└── Segmentos
    ├── Clínica / Agenda
    ├── Salão / Agenda
    ├── Pet Shop / Agenda
    └── Restaurante / Cardápio + Pedidos
```

Essa abordagem evita criar sistemas separados e permite ampliar o mercado da Lívia mantendo a mesma infraestrutura principal.

---

**Status:** especificação inicial / ideia para desenvolvimento futuro.

**Prioridade atual:** não interferir na revisão de produção da Meta; desenvolver o modo Restaurante de forma isolada do fluxo submetido quando necessário.
