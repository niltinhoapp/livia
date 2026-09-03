# Lívia — Foco Operacional

## Missão desta fase

**Colocar a Lívia trabalhando com clientes reais e começar a gerar receita.**

Este arquivo é o checklist prático das próximas sessões. O `README.md` contém a direção oficial do projeto.

---

## Regra principal

Não desenvolver recurso novo por entusiasmo ou roadmap.

Uma alteração só entra agora quando resolver diretamente um destes pontos:

- venda;
- ativação;
- atendimento;
- agenda/operação;
- cobrança;
- erro real de produção.

Caso contrário: backlog.

---

# Checklist de retomada

## 1. Estado técnico

- [ ] Confirmar branch/commit que está em produção.
- [ ] Confirmar deploy atual da Vercel.
- [ ] Confirmar que não há mudança pendente importante fora do GitHub.
- [ ] Rodar suíte completa de testes.
- [ ] Rodar TypeScript.
- [ ] Rodar build.

## 2. WhatsApp real

- [ ] Mensagem chega ao webhook.
- [ ] Estabelecimento correto é identificado.
- [ ] Conversa correta é carregada.
- [ ] Resposta é enviada uma única vez.
- [ ] Mensagem fica registrada.
- [ ] Não há resposta cruzada entre tenants.

## 3. Conhecimento

Testar perguntas reais de estabelecimento:

- [ ] preço;
- [ ] horário de funcionamento;
- [ ] endereço;
- [ ] serviço;
- [ ] pergunta não cadastrada.

Esperado: usar fonte real quando existir e não inventar quando não existir.

## 4. Agenda — fluxo principal

- [ ] “Quero marcar um horário”.
- [ ] serviço é coletado.
- [ ] data é coletada.
- [ ] disponibilidade real é consultada.
- [ ] opções reais são apresentadas.
- [ ] cliente escolhe.
- [ ] agendamento é persistido.
- [ ] painel mostra o agendamento.

## 5. Agenda — cliente já agendado

Testar frases reais:

- [ ] “Tenho consulta hoje?”
- [ ] “Qual horário marquei?”
- [ ] “Quando é minha consulta?”
- [ ] “Confirma minha consulta.”
- [ ] “Olhe a agenda, está marcado hoje às 9.”

Esperado:

- backend consulta o Appointment real;
- não oferecer horários livres como se o cliente não estivesse marcado;
- não inventar hoje/amanhã;
- não responder “vou verificar” sem continuação;
- não fazer handoff se os dados reais já responderem à pergunta.

## 6. Remarcação e cancelamento

- [ ] cliente remarca um agendamento existente;
- [ ] disponibilidade é validada;
- [ ] registro correto é alterado;
- [ ] cliente cancela;
- [ ] status correto é persistido;
- [ ] dashboard/funil não ficam inconsistentes.

## 7. Handoff humano

- [ ] cliente pede atendente humano;
- [ ] conversa muda realmente para handoff;
- [ ] humano consegue assumir;
- [ ] IA não continua respondendo enquanto humano atende;
- [ ] humano consegue devolver conversa para IA;
- [ ] contexto necessário permanece disponível.

## 8. CRM e painel

- [ ] cliente aparece no CRM;
- [ ] nome/telefone corretos;
- [ ] intenção faz sentido;
- [ ] resumo não inventa fatos;
- [ ] pendência representa situação real;
- [ ] caixa de entrada classifica corretamente;
- [ ] dashboard deriva números de documentos reais;
- [ ] funil nunca ultrapassa 100%;
- [ ] múltiplos agendamentos da mesma conversa não inflam conversão.

## 9. Meta

Enquanto estiver em análise:

- [ ] não alterar permissões sem necessidade;
- [ ] não alterar Embedded Signup sem necessidade;
- [ ] não alterar configuração externa do webhook sem necessidade;
- [ ] não alterar WABA da revisão sem necessidade.

Quando houver aprovação:

- [ ] confirmar status/permissões;
- [ ] revisar variáveis de produção;
- [ ] retirar bypass de teste quando aplicável;
- [ ] testar Embedded Signup real;
- [ ] testar mensagem recebida;
- [ ] testar resposta enviada;
- [ ] testar agenda;
- [ ] testar handoff.

## 10. Trial e cobrança

Antes de abrir aquisição em escala:

- [ ] novo estabelecimento inicia 7 dias grátis corretamente;
- [ ] não exige cartão para iniciar, conforme oferta atual;
- [ ] data de início/fim é confiável;
- [ ] acesso durante trial funciona;
- [ ] fim do trial não deixa uso pago liberado indevidamente;
- [ ] caminho para assinatura é simples;
- [ ] pagamento aprovado libera acesso;
- [ ] cancelamento segue a regra comercial;
- [ ] status da assinatura é confiável.

## 11. Primeiro cliente real

- [ ] cadastrar/configurar estabelecimento real;
- [ ] conectar WhatsApp pelo fluxo oficial quando produção estiver disponível;
- [ ] preencher conhecimento real;
- [ ] configurar agenda real;
- [ ] acompanhar primeiras conversas;
- [ ] registrar toda falha real;
- [ ] corrigir causa raiz;
- [ ] adicionar teste de regressão;
- [ ] acompanhar até atendimento ficar estável.

---

# Regra para bugs reais

Para cada problema:

```text
Mensagem real
+ estado real dos dados
+ comportamento errado
        ↓
reprodução
        ↓
causa raiz
        ↓
correção mínima
        ↓
teste de regressão
        ↓
teste real
```

Não resolver problema crítico apenas acrescentando instruções ao prompt se o backend puder garantir a ação.

---

# Não fazer agora

A menos que se torne requisito para um cliente pagante:

- modo restaurante completo;
- áudio;
- integrações extras;
- campanhas avançadas;
- reativação avançada;
- redesign grande;
- novos canais;
- features experimentais.

---

# Indicadores desta fase

Acompanhar:

```text
Estabelecimentos ativados
Conversas reais atendidas
Agendamentos/tarefas concluídos
Resolução sem humano
Erros reais
Trials ativos
Trials convertidos
Assinantes pagos
MRR
```

---

# Resultado esperado

A fase termina quando a Lívia não estiver apenas “pronta no código”, mas **trabalhando diariamente para estabelecimentos reais e recebendo assinaturas**.

> Produto agora é atendimento funcionando + cliente usando + cobrança acontecendo.