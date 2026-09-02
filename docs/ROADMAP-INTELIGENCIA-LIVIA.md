# Lívia — Roadmap de Inteligência

## Objetivo

Evoluir a Lívia de uma IA que apenas responde mensagens para uma **recepcionista operacional inteligente**, capaz de entender contexto, consultar dados reais, lembrar informações relevantes, seguir próximos passos e aprender com correções do estabelecimento.

Este roadmap prioriza melhorias internas que podem ser desenvolvidas **sem alterar a configuração do app da Meta atualmente em análise**.

## Princípio

A Lívia deve responder menos com base apenas no texto do prompt e mais com base em:

- contexto da conversa;
- memória estruturada do cliente;
- dados reais do estabelecimento;
- regras do segmento;
- estado atual da tarefa;
- ferramentas internas;
- nível de confiança da informação.

---

## 1. Memória estruturada do cliente

A Lívia deve conseguir lembrar informações úteis entre conversas, sem depender de reler todo o histórico.

Exemplos:

- nome;
- preferências;
- último serviço ou pedido;
- profissional preferido;
- horário preferido;
- endereço frequente;
- histórico de reclamações relevantes;
- observações autorizadas pelo estabelecimento;
- última interação;
- status atual do relacionamento.

Estrutura conceitual:

```text
customerProfile
  phone
  name
  preferences
  lastService
  lastOrder
  preferredProfessional
  preferredTime
  frequentAddress
  notes
  lastInteractionAt
```

### Regra

A memória deve armazenar fatos úteis e estruturados, não simplesmente copiar toda a conversa.

---

## 2. Detecção de intenção

Antes de responder, a Lívia deve identificar o que o cliente realmente quer fazer.

Exemplos de intenções:

- agendar;
- remarcar;
- cancelar;
- consultar preço;
- tirar dúvida;
- fazer pedido;
- consultar status;
- reclamar;
- falar com humano;
- pedir endereço;
- pedir horário de funcionamento.

Exemplo conceitual:

```text
intent
  type: "schedule_appointment"
  confidence: 0.96
  entities:
    preferredDate: "sexta"
    preferredPeriod: "tarde"
```

A intenção deve ajudar a selecionar o próximo fluxo/ferramenta correta.

---

## 3. Próximo passo estruturado

A IA não deve improvisar toda a conversa livremente.

Cada intenção pode possuir um estado e um próximo passo esperado.

Exemplo de agendamento:

```text
collect_service
→ collect_date
→ check_availability
→ offer_options
→ confirm
→ create_appointment
```

Exemplo de restaurante:

```text
select_items
→ delivery_or_pickup
→ collect_address
→ calculate_total
→ payment_method
→ confirm
→ submit_order
```

Isso reduz respostas incoerentes e aumenta a capacidade da Lívia de concluir tarefas.

---

## 4. Consulta a dados reais antes da resposta

Sempre que houver uma fonte de verdade interna, a Lívia deve consultá-la antes de responder.

Exemplos:

- agenda;
- horários disponíveis;
- cardápio;
- preços;
- disponibilidade de produtos;
- horário do estabelecimento;
- regras de entrega;
- dados do cliente;
- status de pedido;
- FAQ/base de conhecimento.

### Regra central

A IA não deve inventar informações que possam ser verificadas no sistema.

---

## 5. Camada de ferramentas internas

Criar uma camada de ferramentas que a IA possa chamar conforme a necessidade.

Exemplos conceituais:

```text
getBusinessHours()
findAvailableAppointments()
createAppointment()
rescheduleAppointment()
cancelAppointment()
searchKnowledgeBase()
getCustomerProfile()
updateCustomerProfile()
searchMenu()
calculateOrder()
createOrder()
requestHumanHandoff()
```

A Lívia deixa de ser somente um modelo de linguagem e passa a funcionar como um agente operacional controlado.

---

## 6. Regras por segmento

Cada tipo de negócio deve ter regras próprias sem criar produtos separados.

Exemplos:

### Clínica

- agenda;
- procedimentos;
- profissionais;
- preparação para consulta;
- remarcação/cancelamento.

### Salão

- serviços;
- profissionais;
- duração;
- agenda;
- combinações de serviços.

### Pet Shop

- tipo de animal;
- raça;
- serviço;
- agenda;
- observações específicas.

### Restaurante

- cardápio;
- adicionais;
- pedidos;
- delivery/retirada;
- pagamento;
- disponibilidade.

---

## 7. Aprendizado com correções do dono

Criar uma forma simples para o estabelecimento corrigir a Lívia.

Exemplo:

A Lívia responde algo incorreto.

O dono clica em:

**Corrigir resposta / Ensinar a Lívia**

E informa a resposta correta.

O sistema pode transformar a correção em:

- FAQ;
- regra;
- informação de negócio;
- preferência de comunicação;
- sugestão de atualização na base de conhecimento.

### Importante

A correção não deve alterar automaticamente regras críticas sem revisão.

---

## 8. Resumo automático das conversas

Ao finalizar uma conversa importante ou realizar handoff humano, gerar um resumo curto e estruturado.

Exemplo:

```text
Cliente: Mariana
Intenção: remarcar consulta
Preferência: sexta à tarde
Horário oferecido: 14h — recusado
Status: aguardando opção após 16h
```

Benefícios:

- humano assume sem reler toda a conversa;
- histórico fica mais útil;
- reduz tokens em conversas futuras;
- facilita relatórios.

---

## 9. Perfil resumido antes de responder

Antes de iniciar uma nova interação, a Lívia pode receber um pequeno contexto como:

```text
Cliente recorrente
Nome: Carlos
Último atendimento: 18/08
Preferência: manhã
Último assunto: limpeza dentária
Sem pendências atuais
```

Isso dá continuidade sem enviar todo o histórico ao modelo.

---

## 10. Checagem de confiança

Antes de afirmar algo sensível ou operacional, a Lívia deve avaliar se possui informação suficiente.

Exemplo conceitual:

```text
confidence < threshold
→ buscar fonte interna
→ se não encontrar: não inventar
→ oferecer handoff humano
```

Isso é especialmente importante para:

- preços;
- agenda;
- ingredientes/alergênicos;
- pagamentos;
- políticas do estabelecimento;
- disponibilidade de produtos;
- informações de saúde.

---

## 11. Fila de pendências

A Lívia deve saber quando uma conversa ficou esperando alguma ação.

Exemplos:

- cliente precisa confirmar horário;
- estabelecimento precisa responder uma exceção;
- pedido aguarda confirmação;
- cliente precisa enviar documento ou endereço;
- pagamento pendente.

Estrutura conceitual:

```text
pendingTask
  type
  conversationId
  customerId
  status
  waitingFor
  createdAt
  dueAt
```

Isso abre caminho para acompanhamento inteligente no futuro.

---

## 12. Contexto temporal

A Lívia deve entender informações relativas ao momento atual usando os dados do estabelecimento.

Exemplos:

- "hoje";
- "amanhã";
- "sexta";
- "depois do almoço";
- "ainda está aberto?";

Sempre combinar linguagem natural com calendário/horário real antes de executar uma ação.

---

## 13. Personalidade por estabelecimento

Permitir ajustes controlados de comunicação:

- mais formal;
- mais acolhedora;
- objetiva;
- uso ou não de emojis;
- nome da atendente;
- termos que devem ou não ser usados.

A personalidade nunca deve alterar fatos operacionais.

---

## 14. Observabilidade da IA

O painel deve permitir entender por que uma conversa não funcionou.

Registrar de forma técnica:

- intenção detectada;
- ferramenta chamada;
- resultado da ferramenta;
- motivo de handoff;
- erro operacional;
- nível de confiança;
- latência;
- uso estimado de tokens/custo.

Não exibir raciocínio interno do modelo ao usuário final.

---

## 15. Controle de custo

Mais inteligência não precisa significar enviar mais contexto ao modelo.

Estratégias:

- resumir conversas antigas;
- enviar apenas dados relevantes;
- usar dados estruturados;
- consultar ferramentas sob demanda;
- limitar histórico bruto;
- evitar chamar IA para tarefas determinísticas simples;
- reutilizar classificações/resultados quando seguro.

---

# Prioridade recomendada

## Fase 1 — Alto impacto / baixo risco

1. memória estruturada do cliente;
2. resumo automático das conversas;
3. detecção de intenção;
4. próximo passo estruturado;
5. consulta a dados reais;
6. painel de correção/"Ensinar a Lívia".

## Fase 2 — Agente operacional

1. camada de ferramentas internas;
2. estados de tarefas;
3. fila de pendências;
4. nível de confiança;
5. regras por segmento.

## Fase 3 — Otimização

1. contexto resumido inteligente;
2. controle avançado de custo;
3. observabilidade;
4. personalização de comportamento;
5. análises de qualidade.

---

# O que pode ser desenvolvido enquanto a Meta está em análise

Pode avançar sem alterar a submissão atual da Meta:

- banco/modelo de memória;
- classificação de intenção;
- regras e prompts internos;
- mecanismos de resumo;
- base de conhecimento;
- telas do painel;
- onboarding por segmento;
- cardápio/restaurante;
- lógica de pedidos;
- ferramentas internas;
- aprendizado com correções;
- métricas e logs internos;
- testes automatizados e unitários.

## Evitar durante a revisão, salvo necessidade

- mudar configuração do app Meta submetido;
- alterar permissões solicitadas;
- trocar configuração do Embedded Signup;
- modificar webhook/configuração externa sem necessidade;
- criar uma nova dependência de aprovação da Meta para funcionalidades internas.

---

# Visão final

A evolução desejada é:

```text
Chatbot com IA
      ↓
IA com contexto
      ↓
IA com memória
      ↓
IA com ferramentas
      ↓
IA que executa tarefas
      ↓
Recepcionista operacional inteligente
```

A vantagem competitiva da Lívia deve vir menos de "conversar bonito" e mais de **entender o que o cliente quer, consultar a fonte correta, executar a próxima ação e saber quando chamar um humano**.
