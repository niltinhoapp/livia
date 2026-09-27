# Lívia V2 — Prioridade de Execução

> Atualizado em 26/09/2026. Este arquivo substitui a sequência antiga que ainda tratava áudio, campanhas e Alimentação como futuras.

## Estado

A V2 já avançou além do roadmap original. Não iniciar uma OT supondo que áudio, campanhas, CRM ou pedidos ainda precisam ser construídos do zero.

## P0 — estabilidade de produção

Sempre primeiro:

- WhatsApp/Meta/Coexistência;
- concorrência e idempotência;
- agenda;
- voz;
- pedidos;
- billing;
- isolamento multi-tenant.

Bug real de produção interrompe feature nova.

## P1 — Prospect e Demo comercial

Objetivo: transformar a conversa com o prospect em demonstração do próprio produto.

- preservar primeiro contato manual;
- Lívia assume somente após resposta/sessão válida;
- apresentação curta;
- priorizar microdemonstração antes do pitch longo;
- áudio como prova prática;
- agenda/pedido Demo com autorização forte;
- nenhuma ação comercial real indevida;
- CTA para cadastro quando houver interesse.

## P2 — validação de Alimentação F1–F8

O núcleo já está entregue. Prioridade agora é uso real:

- cardápio;
- carrinho;
- confirmação;
- entrega/retirada;
- horários;
- overnight;
- estados;
- notificações;
- experiência do comerciante no painel.

Não reimplementar F1–F8.

## P3 — Billing e acesso

Asaas já possui fluxo de PIX e webhook. Próximas mudanças devem partir do estado real do código e validar:

- trial;
- grace;
- suspensão/reativação;
- gates de serviço;
- UX do plano;
- produção Asaas.

Nunca desconectar Meta/WhatsApp como efeito de cobrança.

## P4 — Campanhas

Campanhas já enviam. Foco é robustez e produto:

- templates;
- contatos;
- limites;
- histórico;
- status;
- UX;
- CRM/origem;
- conformidade Meta.

## P5 — novos verticais

Antes de criar vertical nova, verificar se o motor de pedidos existente atende por configuração.

Exemplo candidato: gás e água. O fluxo pode reutilizar produto → quantidade → endereço → pagamento → confirmação → operação. Só criar código específico quando uma regra real não couber no domínio atual.

## P6 — evolução futura

- importação de cardápio por foto/arquivo com revisão humana;
- pagamentos do cliente final separados do billing SaaS;
- equipes/roteamento;
- múltiplos números;
- automações;
- telemetria de IA.

## Regra para agentes

```text
main atual
→ auditoria read-only
→ confirmar o que já existe
→ escopo mínimo
→ branch
→ implementação
→ testes
→ PR
→ comparar com main
→ merge controlado
```

Documentação antiga não é autorização para reconstruir feature já entregue.
