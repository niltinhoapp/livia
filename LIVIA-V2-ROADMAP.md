# Lívia V2 — Roadmap Oficial

## Status

Este documento descreve a evolução planejada da Lívia após a estabilização da V1.

**A V1 continua sendo o núcleo operacional em produção. A V2 deve ser construída de forma incremental, reversível e sem interromper o atendimento atual.**

Nada neste documento autoriza reescrever fluxos estáveis apenas para preparar o futuro.

---

# 1. Visão da V2

A Lívia evolui de uma recepcionista inteligente para uma plataforma operacional de atendimento, CRM, marketing e vendas pelo WhatsApp.

```text
WhatsApp
   ↓
Lívia IA
   ↓
Atendimento
   ↓
CRM
   ↓
Marketing
   ↓
Oportunidade
   ↓
Venda
   ↓
Pagamento
   ↓
Relacionamento
```

O CRM será o núcleo que conecta todas as áreas.

---

# 2. Regra de evolução

A V2 deve preservar:

- multi-tenant;
- isolamento entre estabelecimentos;
- Meta Cloud API;
- Coexistência;
- conexão existente;
- agenda;
- conhecimento;
- conversas;
- handoff;
- autenticação;
- histórico;
- CRM atual;
- segurança e idempotência;
- dados existentes.

Toda nova capacidade deve ser adicionada por contratos pequenos, testes de regressão e rollout controlado.

---

# 3. CRM V2 como centro do produto

O CRM deixa de representar apenas quem conversou e passa a representar a jornada completa do cliente.

Modelo conceitual:

```text
Customer
├── identity
├── phone
├── source
├── tags
├── segment
├── intent
├── stage
├── owner/responsible
├── conversations
├── appointments
├── campaigns
├── opportunities
├── orders
├── payments
└── timeline
```

O mesmo cliente deve possuir uma identidade central dentro de cada estabelecimento.

Não criar CRM separado para marketing, vendas ou atendimento.

---

# 4. Timeline unificada

A timeline deve registrar eventos relevantes da jornada.

Exemplo:

```text
Cliente iniciou conversa
Intenção detectada
Lívia respondeu
Agendamento criado
Campanha enviada
Cliente respondeu à campanha
Oportunidade criada
Cobrança enviada
Pagamento aprovado
Venda concluída
```

A timeline deve ser derivada de eventos reais, nunca de inferência do modelo.

---

# 5. Multimídia

## 5.1 Áudio

Fluxo alvo:

```text
Cliente envia áudio
        ↓
Webhook
        ↓
Identificar mídia
        ↓
Baixar mídia com segurança
        ↓
Transcrever
        ↓
Salvar áudio + transcrição
        ↓
IA interpreta
        ↓
Atendimento normal
```

A transcrição deve ficar associada à mensagem original.

## 5.2 Imagem

```text
Cliente envia imagem
       ↓
Webhook
       ↓
Download seguro
       ↓
Análise multimodal quando necessária
       ↓
Contexto da conversa
       ↓
Resposta
```

A Lívia não deve concluir fatos críticos apenas por interpretação visual sem validação adequada.

## 5.3 Documentos

Preparar arquitetura para documentos enviados pelo cliente, com controle de tipo, tamanho, armazenamento e finalidade.

---

# 6. Campanhas de marketing

A V2 terá uma área própria de Campanhas.

Não tratar internamente como simples "disparo em massa".

Fluxo:

```text
Criar campanha
      ↓
Selecionar audiência
      ↓
Escolher template aprovado
      ↓
Validar elegibilidade
      ↓
Programar/enfileirar
      ↓
Meta Cloud API
      ↓
Status por destinatário
      ↓
CRM
```

Segmentações futuras podem considerar:

- clientes;
- leads;
- intenção;
- estágio do funil;
- tags;
- serviço de interesse;
- última interação;
- clientes inativos;
- clientes que compraram;
- clientes que ainda não compraram.

Campanhas devem respeitar as políticas vigentes da Meta, consentimento, opt-out, templates e cobrança aplicável.

---

# 7. Templates Meta

Modelo conceitual:

```text
Template
├── establishmentId
├── metaTemplateName
├── category
├── language
├── status
├── variables
├── createdAt
└── updatedAt
```

A Lívia não deve criar mecanismos para contornar políticas, limites ou tarifação da Meta.

---

# 8. Motor de campanhas

O envio deve ser assíncrono.

Nunca executar centenas de envios em um único request HTTP.

Arquitetura:

```text
Campaign
   ↓
Audience
   ↓
Queue
   ↓
Workers
   ↓
Meta
   ↓
Webhooks
```

Estado por destinatário:

```text
pending
queued
sent
delivered
read
failed
replied
opted_out
```

Uma falha individual não pode derrubar a campanha inteira.

---

# 9. Campanha → IA → CRM

```text
Campanha
   ↓
Cliente recebe
   ↓
Cliente responde
   ↓
Lívia assume
   ↓
IA entende intenção
   ↓
CRM
   ↓
Oportunidade
   ↓
Agenda / venda / humano
```

Campanha não termina em "mensagem enviada". Ela deve alimentar atendimento e CRM.

---

# 10. Vendas pelo WhatsApp

A V2 deve permitir transformar uma conversa em oportunidade comercial.

```text
Conversa
   ↓
Intenção de compra
   ↓
Opportunity
   ↓
Order
   ↓
Payment
```

A IA pode conduzir a conversa, mas valores, disponibilidade, cobrança e confirmação de pagamento devem vir do backend ou da fonte oficial.

---

# 11. Asaas

O Asaas será o provedor financeiro inicial.

O domínio da Lívia não deve ficar acoplado ao Asaas.

```text
PaymentProvider
       ↓
      Asaas
```

Isso permite trocar ou adicionar provedores futuramente sem reconstruir CRM e vendas.

---

# 12. Separar dois fluxos financeiros

## 12.1 Cobrança da assinatura da Lívia

```text
Estabelecimento
→ benefício/trial
→ plano
→ assinatura
→ Asaas
→ acesso da Lívia
```

## 12.2 Cobrança dos clientes do estabelecimento

```text
Cliente final
→ oportunidade
→ pedido/serviço
→ cobrança
→ pagamento
→ CRM
```

Esses domínios não podem compartilhar estados de forma ambígua.

---

# 13. Pagamentos no WhatsApp

Quando habilitado para um estabelecimento:

```text
Cliente demonstra intenção
        ↓
Produto/serviço confirmado
        ↓
Backend determina valor
        ↓
Cobrança criada
        ↓
PIX/link de pagamento
        ↓
Cliente paga
        ↓
Webhook Asaas
        ↓
Backend confirma
        ↓
CRM atualizado
        ↓
Lívia informa confirmação
```

Regra absoluta:

> A Lívia nunca confirma pagamento apenas porque o cliente disse que pagou ou enviou comprovante.

Somente evento confiável do provedor/backend altera a cobrança para paga.

---

# 14. Entidades comerciais

Preparar o domínio para entidades independentes:

```text
Opportunity
Order
Payment
Subscription
Plan
Benefit
Campaign
CampaignRecipient
```

Relacionamento principal:

```text
Customer
   ↓
Opportunity
   ↓
Order
   ↓
Payment
```

---

# 15. Planos e benefícios da Lívia

Não fixar a arquitetura em um único preço ou plano.

```text
Plan
├── id
├── name
├── price
├── billingCycle
├── features
├── limits
└── active
```

Benefícios devem ser independentes do preço-base:

```text
Benefit
├── type
├── value
├── startsAt
├── endsAt
├── billingCycles
├── reason
└── grantedBy
```

Exemplos:

- percentual;
- valor fixo;
- meses grátis;
- cortesia;
- parceria;
- condição de cliente fundador.

---

# 16. Controle de acesso inicial

Separar:

```text
panelAccess
whatsappAccess
trialStatus
subscriptionStatus
```

Usuários podem acessar o painel sem necessariamente possuir autorização para conectar um WhatsApp durante a abertura controlada.

O backend deve aplicar a regra de acesso; esconder botão no frontend não é suficiente.

---

# 17. Múltiplos números e equipes

A V2 deve suportar dois conceitos diferentes.

## 17.1 Vários números oficiais por empresa

Um mesmo estabelecimento poderá, futuramente, conectar mais de um número oficial à Lívia.

```text
Establishment
├── WhatsappChannel A
├── WhatsappChannel B
└── WhatsappChannel C
```

Cada canal mantém seu próprio `phoneNumberId`, WABA, modo de conexão, status e credenciais necessárias, mas compartilha o mesmo CRM quando pertence ao mesmo estabelecimento.

O roteamento sempre deve partir do `phoneNumberId` recebido no webhook.

## 17.2 Um número oficial + vários membros internos

Casos como imobiliárias, concessionárias, clínicas, lojas e equipes comerciais precisam de um diretório interno de pessoas.

Exemplo:

```text
Empresa
├── WhatsApp oficial conectado à Meta
└── Team
    ├── Corretor A
    ├── Corretor B
    ├── Corretor C
    └── Gerente
```

Esses contatos internos não precisam ser números conectados à Meta.

Modelo conceitual:

```text
TeamMember
├── id
├── establishmentId
├── name
├── role
├── phone
├── email
├── specialties
├── territory
├── active
└── routingRules
```

A Lívia poderá usar esse diretório para:

- atribuir lead;
- direcionar handoff;
- notificar responsável;
- registrar dono da oportunidade;
- separar atendimento por unidade, região ou especialidade;
- escalar para gerente;
- acompanhar histórico por responsável.

Não misturar `TeamMember` com `Customer`.

---

# 18. Roteamento inteligente

Preparar um domínio de roteamento independente do prompt.

Exemplos:

```text
lead de imóvel em região X
→ corretor responsável por X

cliente pede financiamento
→ equipe financeira/comercial autorizada

cliente pede humano
→ responsável disponível
```

A IA pode classificar a intenção, mas a escolha final deve obedecer regras persistidas e auditáveis.

---

# 19. Lista de espera e abertura controlada

Enquanto a operação estiver em expansão controlada:

```text
Usuário
  ↓
Painel disponível
  ↓
WhatsApp indisponível se sem vaga
  ↓
Lista de espera
```

Isso permite crescer sem abrir conexões ilimitadas antes da cobrança, suporte e operação estarem preparados.

---

# 20. Automações V2

Depois da fundação estar estável:

```text
Event
  ↓
Rule
  ↓
Action
```

Exemplos:

- cliente ficou inativo;
- agendamento próximo;
- pagamento aprovado;
- lead respondeu campanha;
- oportunidade sem resposta;
- pedido de humano;
- mudança de estágio.

Automações devem respeitar consentimento e regras do canal.

---

# 21. Dashboard V2

## Atendimento

- conversas;
- resolução por IA;
- handoffs;
- tempo de atendimento;
- volume por canal.

## Marketing

- campanhas;
- enviados;
- entregues;
- lidos;
- respostas;
- falhas;
- opt-outs.

## Comercial

- leads;
- oportunidades;
- responsáveis;
- conversões;
- vendas.

## Financeiro

- cobranças;
- pagamentos;
- receita;
- inadimplência.

Métricas devem ser derivadas de dados persistidos, não do texto gerado pela IA.

---

# 22. Evolução do modelo de IA

A V1 usa um modelo econômico para atendimento. A V2 precisa de uma camada de IA configurável, porque áudio, visão, roteamento, CRM e vendas exigem mais capacidade e diferentes custos.

Princípios:

- não hardcodear o modelo em vários arquivos;
- centralizar configuração;
- permitir troca por ambiente;
- medir custo, latência e qualidade;
- permitir modelos diferentes por tarefa;
- preservar ferramentas e contratos existentes;
- não fazer troca global sem regressão.

Arquitetura alvo:

```text
AI Gateway
├── conversation model
├── extraction/classification model
├── multimodal model
└── fallback/escalation model
```

Para a próxima etapa, deve ser feito benchmark com modelos atuais da OpenAI antes da migração em produção.

Candidato inicial recomendado para equilíbrio entre inteligência e custo: **GPT-5.6 Terra**.

Para casos de maior complexidade, a arquitetura pode permitir escalonamento controlado para **GPT-5.6 Sol**.

Modelos mais caros não devem ser usados em toda mensagem apenas por serem mais capazes.

A troca de modelo deve ser tratada como mudança de infraestrutura de IA, com testes reais de:

- naturalidade;
- uso correto de ferramentas;
- agenda;
- contexto;
- multimídia;
- latência;
- custo por conversa;
- regressão de segurança.

---

# 23. Segurança V2

Preservar:

- isolamento multi-tenant;
- HMAC;
- idempotência;
- criptografia de tokens;
- deduplicação;
- autorização backend;
- ownership;
- controle de handoff;
- Coexistência.

Adicionar progressivamente:

- idempotência Asaas;
- proteção contra cobrança duplicada;
- controle e expiração de mídia;
- limites de tamanho;
- auditoria de campanhas;
- opt-out;
- auditoria financeira;
- autorização por membro/equipe;
- isolamento por canal/número;
- logs de roteamento.

---

# 24. Ordem oficial de implementação

## V2.0 — Fundação

Preparar contratos do CRM para timeline, canais, equipe, oportunidades e pagamentos sem ativar tudo de uma vez.

## V2.1 — Billing da Lívia

Asaas, planos, benefícios, assinatura, suspensão e reativação.

## V2.2 — IA mais capaz

Centralizar AI Gateway, criar benchmark, migrar de forma controlada o modelo de atendimento e manter fallback.

## V2.3 — Multimídia

Áudio, transcrição e imagem.

## V2.4 — CRM comercial e equipes

Oportunidades, responsáveis, múltiplos membros, roteamento e timeline unificada.

## V2.5 — Campanhas

Templates, audiência, fila, status e integração com CRM.

## V2.6 — Pagamentos no atendimento

Cobranças dos clientes finais via arquitetura financeira separada do billing SaaS.

## V2.7 — Múltiplos números oficiais

Vários canais por estabelecimento, depois que o modelo de canal estiver estabilizado com um número.

## V2.8 — Automações

Follow-up, reativação, lembretes e jornadas.

---

# 25. Regra para Claude e Codex

Nenhuma ferramenta deve receber a instrução genérica "implemente a V2".

Cada Ordem de Trabalho deve executar apenas uma fatia pequena.

Processo obrigatório:

```text
Auditar main e produção
      ↓
Mapear contratos afetados
      ↓
Propor alteração mínima
      ↓
Criar branch isolada
      ↓
Implementar
      ↓
Testes + regressão
      ↓
TypeScript + build
      ↓
PR
      ↓
Preview/checks
      ↓
Validar
      ↓
Merge somente com verde
```

Interromper automaticamente em caso de:

- testes vermelhos;
- conflito;
- alteração fora do escopo;
- mudança destrutiva;
- incompatibilidade de dados;
- risco para Meta/Coexistência;
- risco para produção atual.

Claude pode ser usado para auditoria arquitetural e Ordens de Trabalho. Codex pode implementar e validar. Ambos devem trabalhar sobre branches isoladas e nunca usar produção como ambiente de experimentação.

---

# 26. Estado oficial

## V1

Atendimento inteligente, WhatsApp oficial, Coexistência, conhecimento, agenda, CRM, handoff, autenticação e operação multi-tenant.

## V2

```text
Atendimento multimodal
+
CRM central
+
Equipes e roteamento
+
Múltiplos números
+
Marketing
+
Campanhas
+
Vendas
+
Pagamentos
+
Automações
```

A direção da V2 é acompanhar toda a jornada:

```text
contato
→ conversa
→ intenção
→ oportunidade
→ responsável
→ venda
→ pagamento
→ relacionamento
```

A V2 só avança sem comprometer o serviço que já está funcionando.