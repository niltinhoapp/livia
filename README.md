# Lívia — Plano Mestre Único

## Objetivo

Este é o documento oficial e único de direção da Lívia.

A partir de agora, arquitetura, inteligência, valor comercial, expansão por segmentos e ordem de implementação ficam concentrados aqui para evitar documentos concorrentes, prioridades misturadas ou execução fora de ordem.

A Lívia deve evoluir de uma IA que apenas responde mensagens para uma **recepcionista operacional inteligente**, capaz de entender contexto, consultar dados reais, lembrar informações relevantes, seguir próximos passos, executar tarefas e aprender com correções do estabelecimento.

> **Posicionamento:** A Lívia atende, organiza e ajuda seu negócio a não perder clientes.

---

# 1. Estado atual do produto

A Lívia já possui uma base funcional em produção.

## Stack

- Next.js (App Router)
- TypeScript
- Firebase / Firestore
- Vercel
- Meta WhatsApp Cloud API
- OpenAI

## Núcleo atual

Fluxo principal:

```text
Cliente envia mensagem no WhatsApp
        ↓
Webhook da Lívia
        ↓
Identificação do estabelecimento
        ↓
Carregamento do conhecimento e contexto
        ↓
IA gera a resposta
        ↓
Resposta enviada pelo WhatsApp
        ↓
Conversa registrada no Firestore
```

## Funcionalidades já existentes

- WhatsApp conectado via fluxo oficial da Meta;
- recebimento e envio de mensagens;
- base de conhecimento;
- painel de conversas;
- handoff humano;
- agenda;
- cálculo de disponibilidade;
- criação de agendamentos pela IA;
- cancelamento/remarcação no motor de agenda;
- autenticação do painel;
- multi-tenant;
- configuração do estabelecimento;
- logs e persistência no Firestore.

## Regra central já válida

A Lívia não deve inventar informações comerciais ou operacionais.

Quando não encontrar uma resposta segura, deve pedir informação adicional ou encaminhar para atendimento humano.

---

# 2. Regra de execução durante a análise da Meta

A revisão da Meta deve permanecer isolada da evolução interna da Lívia.

## Evitar alterar sem necessidade

- app Meta submetido;
- permissões solicitadas;
- Embedded Signup;
- configuração externa do webhook;
- WABA utilizada na revisão;
- fluxo já submetido à análise.

## Pode evoluir normalmente

- Firestore;
- modelos de dados;
- memória;
- prompts;
- classificação de intenção;
- resumos;
- regras internas;
- agenda;
- painel;
- CRM;
- oportunidades;
- cardápio;
- pedidos;
- ferramentas internas;
- observabilidade;
- testes.

---

# 3. Princípio de arquitetura

A Lívia deve continuar sendo **um único produto**.

```text
Lívia Core
├── WhatsApp
├── IA
├── Conversas
├── Memória
├── Ferramentas
├── Handoff
├── Autenticação
├── CRM
└── Segmentos
    ├── Clínica / Agenda
    ├── Salão / Agenda
    ├── Pet Shop / Agenda
    └── Restaurante / Cardápio + Pedidos
```

Os segmentos devem reutilizar o mesmo núcleo e apenas adicionar regras e ferramentas específicas.

---

# 4. Regra de ouro da inteligência

A inteligência da Lívia não será medida por tamanho de prompt, quantidade de tokens ou liberdade da IA.

Será medida pela capacidade de:

1. lembrar corretamente quem é o cliente;
2. identificar o que ele quer;
3. saber em qual etapa da tarefa está;
4. consultar a fonte correta;
5. executar a próxima ação;
6. não inventar quando não sabe;
7. chamar um humano no momento certo;
8. continuar uma conversa sem recomeçar do zero;
9. registrar pendências;
10. transformar atendimentos em oportunidades úteis para o negócio.

---

# 5. Plano oficial de implementação

A partir daqui, a execução deve seguir esta ordem. Não avançar para uma etapa posterior sem validar a anterior.

## PASSO 1 — Memória estruturada do cliente

### Objetivo

Fazer a Lívia reconhecer clientes recorrentes e manter fatos úteis entre conversas.

### Estrutura sugerida

```text
customerProfile
  phone
  name
  preferences
  preferredProfessional
  preferredTime
  frequentAddress
  lastService
  lastOrder
  notes
  lastIntent
  lastInteractionAt
  updatedAt
```

### Regras

- não salvar todo o histórico como memória;
- salvar apenas fatos úteis;
- manter isolamento por estabelecimento;
- atualizar dados de forma controlada;
- não substituir um dado confiável por uma inferência fraca da IA.

### Critério de conclusão

Um cliente que volta a conversar não deve ser tratado como desconhecido quando já existirem informações confiáveis sobre ele.

---

## PASSO 2 — Resumo automático de conversa

### Objetivo

Criar um resumo curto e estruturado quando houver encerramento relevante, mudança de estado ou handoff.

Exemplo:

```text
Cliente: Mariana
Intenção: remarcar consulta
Preferência: sexta à tarde
Horário recusado: 14h
Pendência: oferecer horário após 16h
```

### Usos

- handoff humano;
- próxima conversa;
- histórico resumido;
- redução de tokens;
- alimentação controlada da memória.

### Regra de custo

Não resumir cada mensagem isoladamente.

---

## PASSO 3 — Detecção de intenção

### Objetivo

Identificar o que o cliente realmente quer antes de escolher a resposta ou ferramenta.

### Intenções iniciais

```text
schedule_appointment
reschedule_appointment
cancel_appointment
ask_price
ask_hours
ask_address
human_handoff
restaurant_order
order_status
complaint
general_question
```

### Estrutura

```text
intent
  type
  confidence
  entities
```

### Regra de custo

Usar lógica determinística ou modelo barato quando suficiente.

---

## PASSO 4 — Estado da tarefa e próximo passo

### Objetivo

Impedir que a IA improvise toda a conversa e esqueça em qual etapa está.

### Agenda

```text
collect_service
→ collect_date
→ check_availability
→ offer_options
→ confirm
→ create_appointment
```

### Restaurante

```text
select_items
→ delivery_or_pickup
→ collect_address
→ calculate_total
→ payment_method
→ confirm
→ submit_order
```

### Estrutura sugerida

```text
conversationTask
  type
  state
  collectedData
  missingData
  updatedAt
```

---

## PASSO 5 — Fonte de verdade obrigatória

### Objetivo

Sempre consultar dados reais quando eles existirem no sistema.

### Fontes que devem prevalecer sobre inferência da IA

- horários;
- agenda;
- profissionais;
- serviços;
- preços;
- FAQ;
- cardápio;
- disponibilidade de produtos;
- taxas;
- dados do cliente;
- status operacional.

### Regra central

```text
Existe dado interno confiável?
        ↓
Sim → consultar e responder com base nele
Não  → não inventar
        ↓
Pedir informação adicional ou fazer handoff
```

---

## PASSO 6 — Camada de ferramentas internas

### Objetivo

Separar decisão da IA da execução segura no backend.

### Ferramentas esperadas

```text
getBusinessHours()
getCustomerProfile()
updateCustomerProfile()
searchKnowledgeBase()
findAvailableAppointments()
createAppointment()
rescheduleAppointment()
cancelAppointment()
searchMenu()
calculateOrder()
createOrder()
requestHumanHandoff()
```

### Regra de segurança

A IA pode decidir qual ação deseja realizar, mas o backend deve validar permissões, dados obrigatórios e consistência antes de executar.

---

## PASSO 7 — Checagem de confiança

### Objetivo

Evitar afirmações operacionais sem fonte confiável.

Aplicar principalmente em:

- preços;
- agenda;
- pagamento;
- políticas do estabelecimento;
- ingredientes e alergênicos;
- disponibilidade;
- informações relacionadas à saúde.

### Fluxo

```text
informação solicitada
→ existe fonte interna?
→ consultar
→ resposta confiável?
   sim: responder
   não: não inventar
→ pedir dado adicional ou chamar humano
```

---

## PASSO 8 — Ensinar a Lívia / Modo Supervisor

### Objetivo

Permitir que o dono corrija respostas e melhore a Lívia sem editar prompts manualmente.

### Ações esperadas

- Corrigir resposta;
- Ensinar nova informação;
- Marcar resposta como boa ou ruim;
- Informar regra do negócio;
- Atualizar FAQ;
- registrar motivo de erro ou handoff.

### Regra

Correções críticas não devem virar regra automaticamente sem revisão.

---

## PASSO 9 — Fila de pendências

### Objetivo

Registrar tarefas não concluídas para que nada importante se perca.

### Estrutura

```text
pendingTask
  type
  conversationId
  customerId
  waitingFor
  status
  createdAt
  dueAt
```

### Exemplos

- aguardando confirmação do cliente;
- aguardando endereço;
- aguardando humano;
- aguardando pagamento;
- aguardando decisão do estabelecimento.

---

## PASSO 10 — CRM automático

### Objetivo

Transformar as próprias conversas em cadastro útil, sem obrigar o estabelecimento a alimentar um CRM manualmente.

### Dados possíveis

- nome;
- telefone;
- última interação;
- interesses;
- serviços anteriores;
- pedidos anteriores;
- profissional preferido;
- horários preferidos;
- status atual;
- pendências;
- observações úteis;
- histórico resumido.

---

## PASSO 11 — Caixa de entrada inteligente

### Objetivo

Fazer o empresário abrir o painel e saber rapidamente onde precisa agir.

### Classificações importantes

- cliente esperando resposta;
- oportunidade de venda;
- agendamento incompleto;
- reclamação;
- conversa urgente;
- atendimento que precisa de humano;
- pedido não concluído.

---

## PASSO 12 — Oportunidades e funil

### Objetivo

Transformar conversas em indicadores e ações comerciais.

### Exemplos de oportunidades

- perguntou preço e sumiu;
- iniciou agendamento e não concluiu;
- recebeu horários e não escolheu;
- cancelou e não reagendou;
- pediu cardápio e não concluiu pedido;
- pediu orçamento e não respondeu.

### Exemplo de funil

```text
30 pessoas pediram informações
23 demonstraram intenção de agendar
14 agendaram
6 não concluíram
3 precisam de acompanhamento
```

---

## PASSO 13 — Painel diário da Lívia

### Objetivo

Mostrar o que aconteceu e o que precisa de atenção em poucos segundos.

Exemplo:

```text
Hoje
42 atendimentos
11 agendamentos
3 cancelamentos
5 oportunidades pendentes
2 conversas precisam de você
```

### Evoluções posteriores

- taxa de conversão;
- horários mais procurados;
- principais dúvidas;
- serviços mais procurados;
- oportunidades recuperadas;
- receita influenciada quando houver dados confiáveis.

---

## PASSO 14 — Agenda inteligente

### Objetivo

Ir além de simplesmente criar horários.

### Evoluções

- duração por serviço;
- profissional;
- encaixes;
- conflitos;
- remarcação;
- cancelamento;
- horários alternativos;
- buracos de agenda;
- lista de espera.

---

## PASSO 15 — Lista de espera inteligente

Quando não houver o horário desejado, registrar o interesse do cliente e permitir aproveitar cancelamentos futuros.

Isso transforma vagas abertas em oportunidade de recuperação de faturamento.

---

## PASSO 16 — Regras por segmento

Somente depois do núcleo estar estável, especializar comportamentos.

### Clínica

- agenda;
- profissionais;
- procedimentos;
- regras de cancelamento;
- preparação para consulta.

### Salão

- serviços;
- duração;
- profissional;
- combinações de serviços;
- agenda.

### Pet Shop

- pet;
- raça;
- porte;
- serviço;
- agenda.

### Restaurante

- cardápio;
- adicionais;
- pedidos;
- delivery/retirada;
- taxa;
- pagamento;
- disponibilidade.

---

## PASSO 17 — Modo Restaurante V1

### Objetivo

Transformar a Lívia em atendente inteligente de pedidos pelo WhatsApp sem tentar virar um PDV ou marketplace.

### Configuração inicial

- nome do restaurante;
- horários;
- endereço;
- retirada;
- delivery;
- regiões atendidas;
- taxa de entrega;
- pedido mínimo;
- formas de pagamento;
- regras específicas.

### Entrada de cardápio desejada

1. PDF;
2. imagem/foto;
3. texto colado;
4. link;
5. cadastro manual.

### Fluxo seguro de importação

```text
Enviar cardápio
→ IA interpreta
→ dono revisa
→ corrige se necessário
→ publica
```

### Estrutura conceitual

```text
restaurantMenu
  categories
  products
  variants
  addons
```

### Regra

A Lívia nunca deve inventar produto, preço, ingrediente ou disponibilidade.

### Estado do pedido

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

Estados possíveis:

```text
building
awaiting_address
awaiting_payment_method
awaiting_confirmation
confirmed
handed_off
cancelled
```

### Fora do escopo inicial

- PDV completo;
- marketplace;
- logística avançada;
- gestão completa de estoque;
- dezenas de integrações com ERP.

---

## PASSO 18 — Follow-up inteligente

### Objetivo

Identificar clientes interessados que não concluíram uma ação.

A inteligência primeiro registra a oportunidade. Qualquer envio proativo futuro deve respeitar as regras do WhatsApp e templates aplicáveis.

---

## PASSO 19 — Pós-atendimento e reativação

### Pós-atendimento

Registrar:

- satisfação;
- problema relatado;
- necessidade de retorno;
- oportunidade futura;
- avaliação;
- nova compra ou novo serviço.

### Reativação

Identificar clientes que deixaram de retornar, por exemplo após 60, 90 ou 180 dias, conforme regra do negócio.

---

## PASSO 20 — Observabilidade e qualidade

### Registrar

- intenção detectada;
- ferramenta chamada;
- sucesso ou erro;
- motivo de handoff;
- estado da tarefa;
- confiança;
- latência;
- tokens estimados;
- custo estimado;
- resposta corrigida pelo dono.

### Métricas futuras

- resolução sem humano;
- taxa de handoff;
- taxa de erro;
- custo médio por conversa;
- intenções mais frequentes;
- tarefas concluídas.

Nunca exibir raciocínio interno do modelo ao usuário final.

---

## PASSO 21 — Personalização controlada

Permitir configuração de estilo:

- formal;
- acolhedora;
- objetiva;
- emojis sim/não;
- nome da atendente;
- termos preferidos;
- termos proibidos.

A personalidade nunca pode alterar fatos operacionais.

---

## PASSO 22 — Áudio e canais futuros

### Áudio no WhatsApp

- receber áudio;
- transcrever;
- identificar intenção;
- aplicar memória e ferramentas;
- responder conforme configuração.

Áudio deve entrar no mesmo núcleo de inteligência, não virar um fluxo separado.

---

# 6. Ordem resumida oficial

```text
1. Memória estruturada
2. Resumo automático
3. Detecção de intenção
4. Estado da tarefa
5. Fonte de verdade
6. Ferramentas internas
7. Checagem de confiança
8. Ensinar a Lívia / Supervisor
9. Fila de pendências
10. CRM automático
11. Caixa de entrada inteligente
12. Oportunidades e funil
13. Painel diário
14. Agenda inteligente
15. Lista de espera
16. Regras por segmento
17. Restaurante V1
18. Follow-up inteligente
19. Pós-atendimento e reativação
20. Observabilidade
21. Personalização
22. Áudio e canais futuros
```

---

# 7. Primeira entrega prática

A primeira evolução deve conter somente o núcleo necessário para tornar a diferença perceptível sem aumentar demais custo ou complexidade:

1. memória estruturada do cliente;
2. resumo automático;
3. intenção detectada;
4. estado da tarefa;
5. consulta obrigatória a dados reais;
6. ferramentas internas essenciais.

Somente depois dessa base estar validada avançaremos para CRM, oportunidades, painel comercial e segmentos avançados.

---

# 8. Estratégia de custo da IA

Mais inteligência não significa enviar mais contexto ao modelo.

## Regras

- usar regras determinísticas quando possível;
- não enviar histórico inteiro;
- carregar apenas memória relevante;
- usar resumos;
- consultar dados sob demanda;
- evitar LLM para cálculos simples;
- evitar LLM para checagens booleanas triviais;
- usar modelo barato para classificação quando suficiente;
- reservar chamadas mais completas para geração final ou casos ambíguos.

---

# 9. Visão comercial final

A Lívia não deve ser vendida apenas como:

> "IA que responde WhatsApp."

A evolução desejada é:

```text
Atender mensagens
       ↓
Entender contexto
       ↓
Lembrar clientes
       ↓
Resolver tarefas
       ↓
Organizar clientes
       ↓
Identificar pendências
       ↓
Encontrar oportunidades
       ↓
Ajudar a proteger e gerar receita
```

O empresário precisa conseguir perceber valor por meio de:

- tempo economizado;
- atendimentos realizados;
- agendamentos ou pedidos gerados;
- oportunidades não concluídas;
- clientes recuperáveis;
- situações que precisam de ação humana.

---

# 10. Regra operacional deste documento

Este `README.md` passa a ser o **plano mestre oficial da Lívia**.

Não criar novos roadmaps paralelos para inteligência, valor comercial ou segmentos.

Quando surgir uma nova ideia:

1. avaliar se ela pertence ao produto;
2. encaixar no passo correto deste plano;
3. atualizar este arquivo;
4. executar somente quando chegar a prioridade correspondente.

Isso evita perda de direção, repetição e implementação fora de ordem.

---

## Próxima execução

**PASSO 1 — Memória estruturada do cliente.**

Antes de alterar comportamento em produção, revisar o modelo de dados, `lib/repo.ts`, `lib/ai/brain.ts` e o webhook atual para encaixar a memória de forma compatível com o que já funciona.
