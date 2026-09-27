# Lívia — Campanhas

> Atualizado em 26/09/2026. Campanhas já estão implementadas e tiveram envio real validado.

## Estado atual

A área de campanhas permite trabalhar com contatos e templates aprovados da Meta e enviar mensagens pela plataforma oficial.

Fluxo:

```text
contatos
→ campanha
→ template Meta aprovado
→ seleção
→ envio autorizado
→ Meta
→ status/histórico
→ resposta do contato
→ conversa normal com a Lívia
```

## Validado

- templates Meta aprovados;
- criação de campanha;
- seleção de contatos;
- envio real;
- histórico/status;
- resposta retornando ao atendimento;
- limite do período gratuito tratado como regra de produto.

## Regras

- não reescrever conteúdo de template aprovado no momento do envio;
- campanha executada é histórico e não deve ser apagada como rascunho;
- rascunho pode ter ação de exclusão conforme UX;
- não usar campanha como justificativa automática para handoff;
- respeitar políticas Meta, consentimento/opt-out, elegibilidade e cobrança;
- não automatizar WhatsApp Web para contornar a plataforma oficial.

## Período gratuito

A regra comercial atual deve permanecer centralizada e auditável. Alterações de limite não devem ficar espalhadas no frontend.

## Robustez

Uma falha individual de destinatário não deve invalidar toda a campanha. Status devem ser persistidos por envio quando o fluxo suportar essa granularidade.

## CRM

Campanha não termina em “enviado”. Quando o contato responde, a conversa volta ao pipeline normal e pode alimentar CRM/oportunidade conforme as regras do produto.

## Próximas melhorias

- melhorar UX de templates/contatos;
- reforçar histórico e estados;
- garantir limites server-side;
- segmentação baseada em dados reais;
- métricas derivadas de eventos persistidos;
- opt-out e conformidade auditáveis.
