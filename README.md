# Lívia — Estado Oficial do Projeto

## Direção atual

A Lívia entrou em uma fase de operação real e evolução controlada.

A prioridade imediata continua sendo:

1. manter atendimento real confiável;
2. preservar Meta/WhatsApp/Coexistência já funcionando;
3. ativar os primeiros estabelecimentos com controle de acesso;
4. estruturar cobrança com Asaas;
5. evoluir a inteligência e o CRM sem interromper produção;
6. construir a V2 por etapas pequenas e reversíveis.

> Regra principal: nenhuma evolução da V2 pode comprometer o serviço atual.

---

# 1. Estado atual validado

A base atual já possui:

- WhatsApp oficial via Meta Cloud API;
- Embedded Signup;
- Coexistência com WhatsApp Business App;
- recebimento e envio de mensagens;
- IA para atendimento;
- base de conhecimento;
- agenda;
- criação, consulta, remarcação e cancelamento de agendamentos;
- memória estruturada do cliente;
- resumo de conversa;
- detecção de intenção;
- estado de tarefa;
- ferramentas internas;
- política para não inventar informações operacionais;
- handoff humano;
- fila de pendências;
- recurso para ensinar/corrigir a Lívia;
- CRM automático;
- caixa de entrada;
- oportunidades/funil;
- dashboard;
- autenticação;
- multi-tenant;
- persistência no Firestore;
- produção em Vercel.

## Meta / Coexistência

A fase de revisão da Meta foi concluída.

A integração foi validada em cenário real de cliente com Business Portfolio separado do Technology Provider.

O fluxo de Coexistência funciona com:

```text
WhatsApp Business App
+
Meta Cloud API
+
Lívia
```

O caso de self-onboarding do próprio portfólio do Technology Provider não deve ser usado como referência de cliente porque a Meta não suporta esse cenário.

Não alterar sem necessidade:

- App Meta;
- Embedded Signup;
- configuração de produção;
- webhook;
- ownership;
- Coexistência;
- proteção de tokens/PINs;
- filtros de echo/history/app-state.

---

# 2. Fase operacional atual

O ciclo oficial permanece:

```text
Cliente real testa
      ↓
Problema real aparece
      ↓
Reproduzir
      ↓
Encontrar causa raiz
      ↓
Corrigir com o menor impacto possível
      ↓
Criar teste de regressão
      ↓
Validar ponta a ponta
      ↓
Voltar ao atendimento real
```

Não corrigir sintomas apenas com prompt quando backend ou dados estruturados puderem garantir o comportamento.

---

# 3. Abertura controlada

A aquisição inicial deve ser controlada.

Separar:

```text
panelAccess
whatsappAccess
trialStatus
subscriptionStatus
```

O usuário pode acessar o painel sem necessariamente possuir uma vaga para conectar WhatsApp.

A autorização de conexão deve ser aplicada no backend.

O painel também possui autorização server-side própria: Firebase Authentication
valida a identidade, `panelAccess` permite ou bloqueia o uso do painel e
`whatsappBeta` controla, separadamente, a coorte de conexão de WhatsApp.

O provisionamento de `panelAccess` usa uma fronteira administrativa distinta,
autenticada por sessão Firebase e autorizada pela allowlist server-only
`PANEL_ADMIN_UIDS`. Um usuário com painel permitido não é platform admin. Sem
essa configuração, a operação administrativa falha fechada. Conceder acesso ao
painel não concede `whatsappBeta`; revogar o painel não desconecta o WhatsApp.

Enquanto cobrança e suporte estão sendo preparados, novos clientes podem entrar por lote controlado e acompanhamento próximo.

---

# 4. Billing

O provedor financeiro inicial será o Asaas.

A arquitetura deve manter regras comerciais dentro da Lívia e usar Asaas como provedor de pagamento.

Preparar desde o início:

- planos;
- assinatura;
- benefícios;
- descontos;
- período grátis/cortesia quando aplicável;
- inadimplência;
- suspensão;
- reativação;
- webhooks idempotentes.

Não desconectar Meta/WhatsApp por inadimplência. O acesso deve ser controlado pela Lívia preservando conexão e dados.

---

# 5. IA

A V1 usa modelo econômico para atendimento.

A V2 deve migrar para uma camada de IA configurável e mais capaz, sem hardcode espalhado no projeto.

A troca deve ser feita somente após benchmark de:

- qualidade de conversa;
- uso de ferramentas;
- agenda;
- contexto;
- multimídia;
- latência;
- custo;
- regressões.

A arquitetura e candidatos atuais estão documentados em `LIVIA-V2-ROADMAP.md`.

---

# 6. V2

A direção oficial da próxima geração está em:

`LIVIA-V2-ROADMAP.md`

A V2 inclui, de forma incremental:

- CRM central com timeline;
- áudio e imagem;
- campanhas de marketing;
- templates Meta;
- fila de envios;
- vendas pelo WhatsApp;
- pagamentos;
- Asaas;
- equipes e responsáveis;
- múltiplos números por empresa;
- um número oficial com vários contatos internos;
- roteamento para corretores/vendedores/técnicos;
- oportunidades e pedidos;
- automações;
- IA mais capaz e configurável.

Nada disso deve ser implementado como um único projeto gigante.

---

# 7. Prioridade de execução

Executar nesta ordem:

1. estabilidade da V1;
2. controle de acesso inicial;
3. billing Asaas;
4. gateway/benchmark de IA;
5. fundação do CRM V2;
6. multimídia;
7. equipes/roteamento;
8. campanhas;
9. pagamentos de clientes finais;
10. múltiplos números oficiais;
11. automações.

A ordem pode mudar somente por bloqueio real de cliente, venda ou operação.

---

# 8. Qualidade mínima

A Lívia deve:

- não inventar agendamentos;
- não inventar preços;
- não inventar disponibilidade;
- não inventar pagamentos;
- consultar dados reais antes de ações críticas;
- preservar contexto;
- evitar duplicações;
- manter isolamento entre estabelecimentos;
- não responder echoes/histórico como mensagem de cliente;
- manter CRM e dashboard baseados em dados reais;
- transferir corretamente para humano;
- ter regressão para bugs reais corrigidos.

---

# 9. Regra para Claude e Codex

Claude e Codex devem trabalhar em branches isoladas.

Processo:

```text
Auditar main/produção
→ definir escopo mínimo
→ branch
→ implementar
→ testes
→ regressão
→ TypeScript/build
→ PR
→ checks/preview
→ validar
→ merge somente verde
```

Parar em caso de erro, conflito, alteração fora de escopo, quebra de contrato, risco de dados ou risco para Meta/produção.

Não usar produção como laboratório.

---

# 10. Documentos oficiais

- `README.md` — estado e direção atual;
- `FOCO-OPERACIONAL.md` — checklist operacional;
- `COEXISTENCE_ROADMAP.md` — histórico/arquitetura da Coexistência implementada;
- `LIVIA-V2-ROADMAP.md` — evolução oficial da V2.

---

# Direção oficial

```text
Preservar V1
   ↓
Clientes reais
   ↓
Cobrança
   ↓
IA mais capaz
   ↓
CRM V2
   ↓
Marketing + Vendas + Pagamentos
   ↓
Escala
```

A Lívia não precisa ser reescrita. Ela deve evoluir sobre o núcleo que já funciona.
