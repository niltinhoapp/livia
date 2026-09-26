# Estado atual da vertical Alimentação

> Atualizado em 26/09/2026. Este arquivo substitui a auditoria de 19/09 que ainda listava F5–F8 e notificações como ausentes.

## Entregue

- cardápio estruturado;
- preço validado no backend;
- categorias e disponibilidade;
- carrinho persistido;
- quantidade, variação e adicionais;
- edição de item;
- cálculo de subtotal/taxa/total;
- entrega/retirada;
- métodos de pagamento e instruções PIX;
- consulta de cardápio pela IA;
- resumo canônico;
- confirmação explícita;
- dedupe/idempotência;
- máquina de estados operacional;
- histórico append-only;
- notificações automáticas;
- janela de 24h para notificações;
- horários de pedidos;
- overnight;
- bloqueio de novos drafts fora do horário;
- painel operacional.

## Fases

| Fase | Estado |
|---|---|
| F1 | concluída |
| F2 | concluída |
| F3 | concluída |
| F4 | concluída |
| F5 | concluída |
| F6 | concluída |
| F7 | concluída |
| F8 | concluída |

## Ainda não tratar como entregue

- pagamento online do pedido do cliente final com conciliação completa;
- importação de cardápio por foto/PDF com revisão;
- onboarding vertical totalmente automatizado;
- telemetria/custeio completo de IA por finalidade.

## Regras de segurança

- backend calcula valores;
- IA não inventa preço;
- IA não confirma pagamento sem fonte confiável;
- pedido Demo não gera efeito operacional real;
- concorrência/idempotência devem ser preservadas;
- mudança de horário deve ser revalidada no backend.

## Fonte de verdade

Para o estado funcional atual, usar este arquivo e `docs/v2-alimentacao/README.md`. Registros datados anteriores são históricos.
