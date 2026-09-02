# Lívia — Ordem prática de implementação da inteligência

## Objetivo

Executar as melhorias de inteligência da Lívia na ordem que entrega mais valor com menor risco técnico, menor custo de IA e sem depender de mudanças na configuração da Meta que está em análise.

A regra é simples:

**primeiro organizar contexto e dados; depois dar ferramentas; por último ampliar autonomia.**

---

# Fase 0 — Proteção da revisão da Meta

Antes de qualquer evolução, manter uma fronteira clara entre o que é interno da Lívia e o que pertence à integração externa da Meta.

## Não mexer sem necessidade

- App Meta submetido;
- permissões solicitadas;
- Embedded Signup;
- configuração externa do webhook;
- configuração da WABA usada na revisão;
- fluxo submetido à análise.

## Pode evoluir normalmente

- Firestore;
- regras internas;
- prompts;
- classificação de intenção;
- memória;
- resumos;
- telas do painel;
- cardápio;
- pedidos;
- agenda;
- logs;
- testes;
- ferramentas internas.

---

# Fase 1 — Memória estruturada do cliente

## Prioridade: máxima

Criar um perfil persistente por cliente dentro de cada tenant.

Exemplo:

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

## Regras

- não salvar todo o histórico como memória;
- salvar somente fatos úteis;
- manter isolamento por tenant;
- permitir atualização controlada;
- evitar substituir um dado confiável por inferência fraca da IA.

## Valor entregue

A Lívia deixa de tratar um cliente recorrente como desconhecido em toda conversa.

---

# Fase 2 — Resumo automático de conversa

## Prioridade: máxima

Ao encerrar uma interação relevante ou entrar em handoff, gerar um resumo curto e estruturado.

Exemplo:

```text
Cliente: Mariana
Intenção: remarcar consulta
Preferência: sexta à tarde
Opção recusada: 14h
Pendência: oferecer horário depois das 16h
```

## Usos

- handoff humano;
- próxima conversa;
- histórico enxuto;
- redução de tokens;
- alimentação controlada da memória.

## Regra de custo

Não resumir toda mensagem isoladamente. Resumir quando houver mudança de estado, encerramento ou handoff.

---

# Fase 3 — Detecção de intenção

## Prioridade: alta

Antes de responder, classificar o objetivo principal da mensagem.

Exemplos:

- schedule_appointment;
- reschedule_appointment;
- cancel_appointment;
- ask_price;
- ask_hours;
- ask_address;
- human_handoff;
- restaurant_order;
- order_status;
- complaint;
- general_question.

Estrutura:

```text
intent
  type
  confidence
  entities
```

## Regra

Classificação simples deve usar modelo barato ou lógica determinística quando possível.

---

# Fase 4 — Estado e próximo passo

## Prioridade: alta

A Lívia deve saber em qual etapa de uma tarefa está.

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

## Estrutura sugerida

```text
conversationTask
  type
  state
  collectedData
  missingData
  updatedAt
```

## Valor entregue

Evita a IA esquecer o que está fazendo ou voltar etapas desnecessariamente.

---

# Fase 5 — Fonte de verdade antes da resposta

## Prioridade: alta

Criar regra central:

> Se a informação existe no sistema, a IA deve consultá-la em vez de inventá-la.

Consultar dados reais para:

- horários;
- agenda;
- profissionais;
- serviços;
- preços;
- FAQ;
- cardápio;
- disponibilidade de produto;
- taxas;
- dados do cliente;
- status operacional.

## Resultado

A Lívia passa a ser menos alucinatória e mais confiável.

---

# Fase 6 — Camada de ferramentas internas

## Prioridade: alta

Padronizar funções que a IA possa chamar.

Exemplos:

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

## Regra de segurança

A IA decide quando pedir uma ação; o backend continua validando se a ação é permitida e se os dados são suficientes.

---

# Fase 7 — Checagem de confiança

## Prioridade: média/alta

Antes de afirmar um dado operacional, avaliar se existe fonte confiável.

Fluxo:

```text
informação solicitada
→ existe fonte interna?
→ consultar
→ encontrou resposta confiável?
   sim: responder
   não: não inventar
→ pedir informação adicional ou fazer handoff
```

Aplicar principalmente em:

- preço;
- horário disponível;
- pagamento;
- política do negócio;
- ingredientes/alergênicos;
- disponibilidade;
- informações relacionadas à saúde.

---

# Fase 8 — Ensinar a Lívia

## Prioridade: média

Adicionar no painel uma ação como:

**Corrigir resposta / Ensinar a Lívia**

O dono informa a informação correta.

O sistema classifica a correção como possível:

- FAQ;
- regra do negócio;
- preferência de comunicação;
- informação operacional;
- atualização de conhecimento.

## Regra

Correções críticas não devem virar regra automaticamente sem revisão.

---

# Fase 9 — Fila de pendências

## Prioridade: média

Criar controle de tarefas não concluídas.

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

Exemplos:

- aguardando confirmação do cliente;
- aguardando endereço;
- aguardando humano;
- aguardando pagamento;
- aguardando decisão do estabelecimento.

Isso prepara a Lívia para acompanhamento proativo no futuro.

---

# Fase 10 — Regras por segmento

## Prioridade: média

Depois do núcleo estar estável, especializar por segmento.

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
- combinação de serviços;
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
- pedido;
- delivery/retirada;
- taxa;
- pagamento.

---

# Fase 11 — Observabilidade e qualidade

## Prioridade: média

Registrar dados técnicos que ajudem a entender falhas sem expor raciocínio interno do modelo.

Registrar:

- intenção detectada;
- ferramenta chamada;
- sucesso/erro da ferramenta;
- motivo de handoff;
- estado da tarefa;
- latência;
- tokens estimados;
- custo estimado;
- resposta corrigida pelo dono.

Criar depois métricas como:

- taxa de resolução sem humano;
- taxa de handoff;
- taxa de erro;
- custo médio por conversa;
- intenções mais frequentes;
- tarefas concluídas.

---

# Fase 12 — Personalização controlada

## Prioridade: menor para a primeira evolução

Permitir configuração de estilo:

- formal;
- acolhedora;
- objetiva;
- emojis sim/não;
- nome da atendente;
- termos preferidos;
- termos proibidos.

Personalidade nunca deve alterar fatos operacionais.

---

# Ordem recomendada de execução

```text
1. Memória estruturada
2. Resumo automático
3. Detecção de intenção
4. Estado/próximo passo
5. Consulta a dados reais
6. Ferramentas internas
7. Checagem de confiança
8. Ensinar a Lívia
9. Fila de pendências
10. Regras por segmento
11. Observabilidade
12. Personalização
```

---

# Primeira entrega recomendada

A primeira entrega de inteligência pode conter apenas:

1. memória estruturada do cliente;
2. resumo de conversa/handoff;
3. intenção detectada;
4. estado da tarefa;
5. consulta obrigatória à agenda/base antes de responder dados operacionais.

Essa combinação já deve produzir uma diferença perceptível no atendimento sem exigir que a Lívia fique muito mais cara ou complexa.

---

# Estratégia de custo

Para controlar gasto de IA:

- usar regras determinísticas quando possível;
- não enviar histórico inteiro;
- carregar somente memória relevante;
- usar resumos;
- consultar dados por ferramenta;
- evitar LLM para cálculos simples;
- evitar LLM para checagens booleanas triviais;
- usar modelos baratos para classificação quando suficiente;
- reservar chamadas mais completas para geração da resposta final ou situações ambíguas.

---

# Critério para dizer que a Lívia ficou mais inteligente

Não medir inteligência por tamanho do prompt ou quantidade de tokens.

Medir por capacidade de:

1. lembrar o cliente corretamente;
2. identificar o objetivo;
3. saber em que etapa está;
4. buscar a fonte correta;
5. concluir uma ação;
6. não inventar quando não sabe;
7. transferir para humano no momento certo;
8. continuar uma conversa sem recomeçar do zero.

---

## Status

Documento de execução derivado do `ROADMAP-INTELIGENCIA-LIVIA.md`.

Pode ser implementado internamente enquanto a revisão da Meta segue separada.
