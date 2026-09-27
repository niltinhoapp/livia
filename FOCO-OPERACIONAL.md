# Lívia — Foco Operacional

> Atualizado em 26/09/2026.

## Missão

Manter a Lívia estável em produção, validar com pessoas reais e evoluir somente onde houver impacto em venda, atendimento, operação ou segurança.

## Estado validado

- [x] Meta / WhatsApp oficial;
- [x] Coexistência;
- [x] webhook E2E;
- [x] agenda;
- [x] conhecimento;
- [x] CRM e handoff;
- [x] áudio: transcrição + resposta em voz quando habilitada;
- [x] conteúdo estruturado em texto mesmo quando a entrada é áudio;
- [x] campanhas com templates Meta e envio real;
- [x] vertical Alimentação F1–F8;
- [x] canal Demo separado do Revenue;
- [x] billing Asaas com PIX e webhook;
- [x] produção Vercel ativa.

## Antes de qualquer mudança

- [ ] atualizar `origin/main`;
- [ ] confirmar commit que está em produção;
- [ ] verificar PRs/branches concorrentes;
- [ ] definir escopo mínimo;
- [ ] criar branch isolada;
- [ ] testar apenas o que foi alterado e regressões relevantes;
- [ ] comparar falhas com `main`;
- [ ] não transformar falha preexistente em “regressão do PR”;
- [ ] não alterar Meta/Coexistência/voz fora do escopo;
- [ ] não expor credenciais.

## Atendimento

Validar periodicamente:

- texto normal;
- áudio normal → resposta em áudio quando configurado;
- áudio pedindo cardápio/lista → resposta estruturada em texto;
- agenda: consultar/criar/remarcar/cancelar;
- handoff;
- mensagens duplicadas;
- echo/history/app-state;
- isolamento entre estabelecimentos.

## Alimentação

Validar:

- cardápio;
- variações/adicionais;
- carrinho;
- entrega/retirada;
- taxa;
- forma de pagamento;
- confirmação explícita;
- horários de pedido;
- overnight;
- estados operacionais;
- notificações;
- cancelamento operacional;
- nenhuma notificação real indevida em pedido Demo.

## Campanhas

Validar:

- templates aprovados aparecem;
- contatos podem ser selecionados/importados conforme fluxo atual;
- template aprovado não é reescrito indevidamente;
- envio inicia somente por ação autorizada;
- status é persistido;
- resposta volta para a conversa;
- limites do período gratuito continuam aplicados.

## Prospect / Demo

Fluxo esperado:

```text
abordagem inicial manual
→ resposta do prospect
→ sessão Prospect válida
→ Lívia se apresenta
→ microdemonstração na conversa
→ interesse
→ teste/cadastro
```

Demo nunca autoriza mutação apenas por contexto textual. Exigir autorização calculada no backend.

## Billing

Preservar:

- customer idempotente;
- subscription idempotente;
- PIX da primeira cobrança;
- webhook Asaas;
- `billingStatus`;
- dados e conexão Meta mesmo em suspensão/cancelamento.

Antes de alterar gates de acesso, auditar o caminho real de produção.

## Regra de bugs

```text
evidência real
→ reprodução
→ causa raiz
→ correção mínima
→ regressão
→ reteste real
```

Não corrigir voz, Meta, agenda ou pedidos “por precaução” quando o fluxo já está validado.

## Próximos focos

1. continuar validação comercial com prospects reais;
2. consolidar experiência Prospect/Demo;
3. ampliar testes reais de Alimentação;
4. revisar documentação/CI separadamente de features;
5. evoluir billing e acesso somente com escopo próprio;
6. avaliar novos verticais reutilizando o motor existente antes de criar código específico.
