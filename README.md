# Lívia — Foco de Produção e Receita

## Objetivo atual

A Lívia entrou em uma nova fase.

O objetivo agora **não é adicionar novas funcionalidades**. O objetivo é **polir o que já existe, estabilizar o atendimento real, liberar produção e começar a gerar receita**.

> **Regra principal:** só entra desenvolvimento novo se for necessário para vender, ativar, atender ou cobrar.

Ideias de expansão continuam válidas, mas ficam congeladas no backlog até o núcleo atual provar estabilidade com clientes reais.

---

# 1. O que a Lívia já possui

A base atual já é suficiente para iniciar operação comercial.

## Produto

- WhatsApp oficial via Meta Cloud API;
- Embedded Signup;
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
- caixa de entrada inteligente;
- oportunidades;
- funil;
- dashboard diário;
- autenticação;
- multi-tenant;
- persistência no Firestore.

## Stack

- Next.js / App Router;
- TypeScript;
- Firebase / Firestore;
- Vercel;
- Meta WhatsApp Cloud API;
- OpenAI.

---

# 2. Fase atual: estabilização

A partir deste ponto, desenvolvimento orientado por roadmap deixa de ser a prioridade.

O ciclo oficial passa a ser:

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

Não corrigir sintomas apenas com prompt quando o problema exigir garantia de backend.

Para ações críticas — agenda, confirmação, cancelamento, dados do cliente, preço, disponibilidade e outras fontes de verdade — o backend deve validar os dados antes da resposta final.

---

# 3. Prioridade absoluta

Executar nesta ordem:

1. **Atendimento real confiável** — Lívia entende a solicitação, consulta dados reais e responde corretamente.
2. **Agenda confiável** — criar, consultar, confirmar, remarcar e cancelar sem inventar horários ou estados.
3. **Handoff confiável** — quando não conseguir resolver, entregar realmente para humano sem deixar o cliente esperando uma ação inexistente.
4. **Onboarding confiável** — estabelecimento consegue entrar, configurar e conectar o WhatsApp sem assistência técnica excessiva.
5. **Painel confiável** — conversas, clientes, agenda, oportunidades e métricas representam dados reais.
6. **Produção Meta** — quando a Meta liberar, validar a integração aprovada sem alterar desnecessariamente o que foi submetido.
7. **Trial e cobrança** — garantir os 7 dias grátis, bloqueio/liberação correta e caminho simples para assinatura.
8. **Primeiros clientes pagantes** — colocar estabelecimentos reais usando diariamente.

---

# 4. Regra de congelamento de escopo

Até a Lívia começar a operar com clientes reais e gerar receita, ficam fora da execução normal:

- modo restaurante completo;
- novas integrações;
- áudio;
- campanhas avançadas;
- reativação avançada;
- novos canais;
- grandes alterações visuais;
- funcionalidades experimentais;
- qualquer expansão que não resolva um bloqueio real de venda, ativação, atendimento ou cobrança.

Esses itens não foram descartados. Apenas **não são prioridade agora**.

---

# 5. Proteção da revisão da Meta

Enquanto o app estiver em análise, evitar mudanças desnecessárias em:

- app Meta submetido;
- permissões;
- Embedded Signup;
- configuração externa do webhook;
- WABA utilizada na revisão;
- fluxo enviado para análise.

Correções internas da Lívia podem continuar desde que não alterem a configuração submetida.

Quando a Meta liberar produção:

1. conferir permissões e status;
2. conferir variáveis de produção;
3. retirar/desativar bypasses exclusivamente de teste quando aplicável;
4. conectar um estabelecimento pelo fluxo oficial;
5. executar teste ponta a ponta de recebimento e resposta;
6. testar agenda e handoff;
7. validar logs;
8. liberar os primeiros usuários.

---

# 6. Critério para aceitar uma mudança

Antes de programar qualquer coisa nova, responder:

> Isso impede ou melhora diretamente venda, ativação, atendimento ou cobrança agora?

Se **sim**, pode entrar na fila atual.

Se **não**, registrar no backlog e continuar estabilizando.

---

# 7. Qualidade mínima para produção

A Lívia deve:

- não inventar agendamentos;
- não inventar preços ou informações operacionais;
- consultar agendamentos existentes antes de responder sobre eles;
- distinguir horário disponível de horário já reservado;
- compreender hoje/amanhã usando data real do estabelecimento;
- não prometer “vou verificar” sem existir continuação real;
- não transferir para humano quando o backend já possui a resposta confiável;
- transferir corretamente quando realmente precisar de humano;
- preservar contexto durante uma tarefa;
- não duplicar ações críticas;
- manter isolamento entre estabelecimentos;
- registrar conversas e operações necessárias;
- manter dashboard e funil derivados de dados reais;
- ter testes de regressão para falhas reais corrigidas.

---

# 8. Estratégia de testes

Nesta fase, **conversa real vale mais que funcionalidade nova**.

Para cada falha encontrada:

1. guardar a frase real do cliente;
2. identificar o estado real no Firestore/agenda;
3. reproduzir o comportamento;
4. corrigir a causa raiz;
5. adicionar teste que reproduza exatamente o caso;
6. rodar suíte completa;
7. validar TypeScript/build;
8. testar novamente no WhatsApp real quando seguro.

Não considerar um bug resolvido apenas porque uma resposta isolada parece correta.

---

# 9. Métricas que importam agora

Acompanhar principalmente:

- estabelecimentos ativados;
- estabelecimentos que concluíram onboarding;
- conversas reais atendidas;
- tarefas/agendamentos concluídos;
- taxa de resolução sem humano;
- handoffs;
- erros operacionais;
- clientes em trial;
- conversão de trial para pago;
- assinantes ativos;
- receita recorrente mensal.

Métricas sofisticadas podem esperar. Primeiro precisamos provar uso e pagamento.

---

# 10. Estratégia comercial imediata

A Lívia deve ser apresentada como uma solução operacional, não como demonstração de IA.

> **Deixe a Lívia atender de verdade no WhatsApp do seu negócio.**

Promessa central:

> **A Lívia atende, organiza e ajuda seu negócio a não perder clientes.**

A primeira validação comercial deve buscar poucos estabelecimentos reais, acompanhar de perto o uso, corrigir rapidamente os problemas e transformar os primeiros casos bem-sucedidos em prova comercial.

---

# 11. Backlog pós-validação

Depois que o núcleo estiver estável e houver clientes usando/pagando, retomar de forma priorizada:

- lista de espera inteligente;
- follow-up;
- pós-atendimento;
- reativação;
- modo restaurante e cardápio;
- áudio;
- personalização avançada;
- novas integrações;
- relatórios comerciais avançados.

O backlog deve ser priorizado por impacto em receita, retenção e redução de trabalho do estabelecimento.

---

# 12. Regra operacional para a próxima sessão

Ao retomar o projeto:

```text
NÃO começar criando recurso novo.

1. Ler este README.
2. Conferir o estado atual da branch/deploy.
3. Verificar erros ou comportamentos reais pendentes.
4. Testar os fluxos críticos existentes.
5. Corrigir somente o que bloquear produção/receita.
6. Criar regressão para cada bug real.
7. Manter a Meta isolada enquanto a revisão estiver em andamento.
```

## Fluxos críticos a polir

- cliente novo inicia conversa;
- cliente pergunta informação da base;
- cliente quer agendar;
- cliente informa data/horário em linguagem natural;
- cliente pergunta por agendamento existente;
- cliente confirma;
- cliente remarca;
- cliente cancela;
- cliente pede humano;
- humano assume e devolve conversa;
- dashboard reflete o ocorrido corretamente;
- CRM registra o cliente corretamente.

---

# Direção oficial

**A Lívia já tem funcionalidades suficientes para começar.**

Agora a prioridade é confiabilidade, produção, primeiros clientes e receita.

```text
Polir
  ↓
Testar com situações reais
  ↓
Corrigir
  ↓
Estabilizar
  ↓
Liberar produção
  ↓
Ativar clientes
  ↓
Cobrar
  ↓
Gerar receita
```

Novas funcionalidades voltam a ser prioridade somente depois que o produto atual estiver trabalhando de verdade.