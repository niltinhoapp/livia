# Lívia Alimentação V2 — Estado Oficial

> Atualizado em 26/09/2026. A documentação anterior parou em F1–F4; o código/produção avançaram até F8.

## Objetivo

Atendimento e operação de pedidos pelo WhatsApp para restaurantes, lanchonetes e delivery, reutilizando o núcleo multi-tenant da Lívia.

## Estado geral

**F1–F8 entregues e mergeadas.** Não reconstruir essas fases.

### F1–F4 — base

- F1: categoria/disponibilidade, taxa por bairro, confiança no catálogo e acesso ao painel;
- F2: configuração de pedido no painel;
- F3: cardápio completo, PIX/instruções e tom de conversa;
- F4: robustez do carrinho, edição de itens e fallback do tool loop.

### F5 — confirmação canônica

- resumo canônico;
- confirmação explícita antes da operação;
- backend como fonte de verdade.

### F6 — máquina de estados operacional

- estados de pedido;
- histórico append-only;
- concorrência/idempotência;
- listagem operacional corrigida.

### F7 — notificações

Notificações automáticas para eventos operacionais relevantes, com janela de 24h e idempotência/identificador de mensagem.

### F8 — horários de pedidos

- `orderHours`;
- herança do expediente quando aplicável;
- suporte a janela overnight;
- bloqueio backend de novos drafts fora do horário;
- resposta conversacional informando fechamento.

## Capacidades atuais

- cardápio estruturado;
- categorias/produtos;
- variações/adicionais;
- carrinho persistido;
- múltiplos itens;
- cálculo backend;
- entrega/retirada;
- taxa;
- métodos de pagamento;
- PIX/instruções;
- resumo;
- confirmação;
- estados operacionais;
- notificações;
- horários;
- painel de pedidos.

## Demo

Pedidos demonstrativos devem nascer como Demo, associados ao lead autorizado. Não converter pedido comercial em Demo depois de criado.

Pedido Demo não pode produzir cobrança, produção, entrega ou notificação operacional real.

## Pagamentos

Não confundir:

1. billing da assinatura da Lívia (`lib/billing/`);
2. pagamento do pedido do cliente final.

O segundo continua domínio próprio e deve manter arquitetura neutra de provedor. A IA nunca marca pagamento como aprovado por fala do cliente ou comprovante.

## Importação de cardápio

Importação por foto/arquivo continua evolução futura. Quando implementada:

- extração não publica automaticamente;
- comerciante revisa;
- preço duvidoso fica pendente;
- publicação usa as mesmas validações do cadastro manual.

## Próxima prioridade

Uso real e regressão de F1–F8 antes de ampliar a vertical. Novos segmentos de pedido (por exemplo gás/água) devem primeiro tentar reutilizar o mesmo motor por configuração.
