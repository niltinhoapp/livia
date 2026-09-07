# Auditoria Mestra — Livia (Fase 0: somente diagnóstico)

**Nenhum código foi alterado para produzir este documento.** Leitura de
repositório, execução da suíte existente (só leitura/execução, sem editar
teste nenhum) e inspeção manual dos módulos citados.

Estado no momento da auditoria:
- HEAD: `4806581` (`fix(cancel): resolve which appointment from the
  customer's own words, not a guessed id`)
- Working tree: limpa, exceto este documento e
  `docs/MODELO-ATENDIMENTO-LIVIA-2026-09-08.md` (ambos novos, não
  rastreados)
- Suíte: **41 arquivos de teste, 483 testes, todos passando**
- Modelo em uso: `gpt-4o-mini` (env `LIVIA_MODEL`, padrão hardcoded)

---

## 1) Arquitetura atual

```
Mensagem (WhatsApp, via webhook)
 ↓
Normalização              app/api/webhooks/whatsapp/route.ts
 ↓                        (assinatura HMAC, parse, dedupe por msg.id)
Contexto                  lib/repo.ts (loadConversation: Conversation + até
 ↓                        12 mensagens de histórico, SÓ TEXTO — ver §7)
Estado                    ConversationTask (Firestore) + intent determinístico
 ↓                        (lib/ai/intent.ts) calculado ANTES da IA
Camada determinística      lib/ai/brain.ts:
 ↓                        resolveTimeSelection() / resolveCancellation()
 ↓                        — tenta resolver e EXECUTAR sem chamar o LLM
Prompt                    buildSystemPrompt() (lib/ai/brain.ts) — monta a
 ↓                        partir de: persona/tom, KB, perfil do cliente,
 ↓                        tarefa em andamento, resultado das etapas
 ↓                        determinísticas acima (já como FATO, não instrução)
LLM                       openai.chat.completions.create(), até 4 iterações
 ↓                        de tool-calling (tool_choice: "auto")
Tools                     lib/ai/tools.ts — 11 ferramentas registradas (§6)
 ↓
Guards (pós-processamento) lib/ai/brain.ts — 7 travas sequenciais sobre o
 ↓                        texto final do modelo (§5)
Persistência               lib/repo.ts: appendMessage, setConversationTask,
 ↓                        setConversationStatus, upsertPendingTask
Resposta                   lib/whatsapp/client.ts: sendText
```

Diferença chave em relação ao diagrama pedido no prompt-mestre: **não existe
uma etapa "Guards" isolada da resposta do LLM que rode ANTES do
pós-processamento textual** — os guards atuais são todos pós-processamento
(rodam sobre `reply` depois que o modelo já respondeu). A validação
"pré-fato" (ex.: `assertSameDay`) vive **dentro das tools**, não como uma
etapa separada do pipeline.

---

## 2) Fluxo completo (linha a linha, com arquivo:função)

1. `POST /api/webhooks/whatsapp` → `handleWebhook` → `processMessage`
   (`app/api/webhooks/whatsapp/route.ts`)
2. Resolve estabelecimento por `phone_number_id` (`findEstablishmentByPhoneNumberId`)
3. `loadConversation` → `Conversation` + histórico (texto puro, últimas 12 msgs)
4. `appendMessage` (mensagem do cliente persistida ANTES de qualquer decisão)
5. Portões: estabelecimento inativo → resposta neutra e para;
   `status === "handoff"` → tenta retomada determinística (`readHumanIntent`/
   `readConfirmation` + `offeredHuman` na última msg da Livia) — se não
   retomar, **silêncio total**, só registra pendência; `status === "human"`
   → silêncio total, sem tentativa de retomada (nunca automático)
6. Atalho determinístico de confirmar/cancelar **lembrete de agendamento**
   (`confirmCancelIntent`, fora de `brain.ts` — caminho paralelo, não usa
   `ConversationTask`)
7. `detectIntent` (determinístico, por palavra-chave — `lib/ai/intent.ts`)
8. `think()` (`lib/ai/brain.ts`) — ver detalhamento abaixo
9. `sendText` → `appendMessage` (resposta) → `deriveTaskState` (próximo
   estado da tarefa) → `setConversationTask` → `upsertPendingTask` /
   `resolvePendingTask` (fila de pendências do painel)

### Dentro de `think()`

```
booking = est.bot.bookingEnabled
config  = getScheduleConfig() (se booking)
now     = nowLocal(offset)      → hoje + amanhã + as 7 próximas datas por
                                   nome de dia, já resolvidos (não é o LLM
                                   que calcula)
statedDate       = parseDateSelection(última msg do cliente, hoje)
discussedDate    = statedDate ?? task.collectedData.date
clienteRecusouHumano = readHumanIntent(última msg) === "declines"

SE intent === check_appointment:
    get_customer_appointments RODA AGORA, antes do LLM (fato obrigatório)

SE booking:
    resolveTimeSelection()   → tenta resolver ESCOLHA DE HORÁRIO sem LLM
    resolveCancellation()    → tenta resolver CANCELAMENTO sem LLM

monta prompt (buildSystemPrompt + bookingOutcomeSection + cancelOutcomeSection)
LOOP (máx. 4x):
    chama o LLM com tools
    SE tool_call: executa via runTool(), acumula toolCalls[], volta ao loop
    SENÃO: texto final → passa pelos 7 guards (§5) → retorna
FIM DO LOOP sem resposta final:
    usa o que já foi produzido no turno (reserva/remarcação feita,
    disponibilidade já consultada) antes de transferir — nunca transfere
    "a seco"
```

---

## 3) Componentes críticos (arquivo → responsabilidade)

| Arquivo | Responsabilidade |
|---|---|
| `lib/ai/brain.ts` | Orquestração: prompt, loop do LLM, guards, resolução determinística de horário/cancelamento/dia-da-conversa/handoff |
| `lib/ai/tools.ts` | As 11 ferramentas (schema + `execute`), validações de posse e de dia |
| `lib/ai/intent.ts` | Classificação de intenção por palavra-chave (zero custo de IA) |
| `lib/ai/timeSelection.ts` | Parsing determinístico de horário (2 funções: `parseTimeSelection`, `extractSingleTime`) |
| `lib/ai/dateSelection.ts` | Parsing determinístico de data (`parseDateSelection`) |
| `lib/ai/confirmation.ts` | Leitura de sim/não (`readConfirmation`) — listas fechadas |
| `lib/ai/humanRequest.ts` | Leitura de pedido/recusa de humano (`readHumanIntent`, `offeredHuman`, `announcesTransfer`) |
| `lib/ai/taskState.ts` | Máquina de estados da tarefa (`deriveTaskState`) — **pura, sem I/O** |
| `lib/scheduling.ts` | Fonte única de "horário reservável" (`slotBookability`, usada tanto por listagem quanto por criação) |
| `app/api/webhooks/whatsapp/route.ts` | Orquestração de entrada/saída, portões de handoff/human, persistência |

---

## 4) Prompts existentes

**Um único prompt de sistema**, montado dinamicamente por `buildSystemPrompt()`
(`lib/ai/brain.ts:168`). Seções, na ordem:

1. Regras fixas (persona, tom, "não invente", "seja breve", proibição de
   promessa vazia, `nowHuman` com as datas já resolvidas)
2. Guardrail médico (se `bot.medicalGuardrail`)
3. Orientação cadastrada pelo estabelecimento ("Ensine a Livia" — tom,
   proibições, gatilhos de handoff extras)
4. Regras de agendamento (se `bookingEnabled`) OU aviso de que não agenda
5. Regra de handoff (pedir humano/request_human_handoff/`[[HANDOFF]]` como
   fallback textual)
6. `=== INFORMAÇÕES DO ESTABELECIMENTO ===` — a base de conhecimento
   **inteira**, sempre, sem filtro por relevância (§30 do prompt-mestre —
   confirmado: sim, vai tudo)
7. `=== O QUE VOCÊ JÁ SABE SOBRE ESTE CLIENTE ===` (perfil, se houver)
8. `=== TAREFA EM ANDAMENTO ===` (se houver `ConversationTask`)
9. `=== ATENÇÃO PARA ESTA RESPOSTA ===` (checagem de confiança —
   `evaluateTrust`, determinístico, só quando falta fonte pra pergunta
   factual)
10. `=== AGENDA REAL DESTE CLIENTE ===` (se `check_appointment`)
11. `=== RESULTADO REAL DA RESERVA ===` (`bookingOutcomeSection` — fato
    consumado: criado/remarcado/conflito/precisa-serviço)
12. `=== CANCELAMENTO (estado real apurado agora) ===`
    (`cancelOutcomeSection` — nenhum/precisa-confirmar/ambíguo/cancelado/
    abortado/falhou)

Durante o loop, até 3 correções injetam mensagens `system` adicionais
**dentro** da mesma chamada (não persistidas): "você prometeu verificar
depois" (enrolação), "você disse que não consegue algo que consegue"
(incapacidade), "nenhuma consulta à agenda foi feita" (desfecho
inventado).

---

## 5) Guards existentes (pós-processamento, todos em `lib/ai/brain.ts`)

Ordem real de execução dentro do loop, sobre `reply` já gerado:

| # | Guard | Dispara quando | Ação |
|---|---|---|---|
| 1 | Consulta de agenda obrigatória | `appointmentLookup?.ok` e a resposta enrola ou está vazia | Substitui pela resposta montada do dado real; se a consulta falhou de verdade, transfere |
| 2 | Cancelamento determinístico | `cancelOutcome` existe e o modelo alegou incapacidade/enrolou | Substitui pelo `composeCancelReply` do outcome real |
| 3 | Incapacidade inventada | `claimsIncapacity(reply)` e há ferramentas disponíveis | 1ª vez: system-message corretiva, tenta de novo; 2ª vez: transfere de verdade |
| 4 | **Reserva existe, texto não confirma** | `booked && bookedInfo && !confirmsBooking(reply)` | Substitui pela confirmação canônica |
| 5 | **Remarcação existe, texto não confirma** | `rescheduled && rescheduledInfo && !confirmsBooking(reply)` | Idem, para remarcação |
| 6 | Desfecho inventado | `deniesBooking(reply)` sem `find_available_appointments`/`create_appointment` no turno | Se a reserva foi criada, corrige; se não consultou, força consulta (1x) ou transfere |
| 7 | Promessa de continuação inexistente | "vou verificar depois" / "já te retorno" | Corrige (1x) ou transfere |
| 8 | **Recusa de humano vence handoff** | `handoffRequested \|\| [[HANDOFF]]` E `clienteRecusouHumano` nesta mesma mensagem | `handoff` forçado a `false` |
| 9 | **Handoff não pode anunciar transferência que não houve** | `!handoff && announcesTransfer(reply)` | Substitui por resposta neutra, seguindo atendimento |
| 10 | Handoff não carrega enrolação | `handoff && looksLikeStalling(reply)` | Substitui pela frase canônica de transferência |
| 11 | Estouro do loop (4 iterações sem texto final) | fora do `for` | Usa o que já foi produzido no turno (reserva/remarcação/disponibilidade), só transfere se não houver nada aproveitável |

**Risco de interação entre guards #4/#5 e #6**: ambos mexem em `reply` a
partir de condições parcialmente sobrepostas (uma reserva criada mais uma
negação no texto). A ordem atual favorece #4/#5 (rodam antes), o que está
correto — mas não há teste que trave explicitamente **a ordem**, só o
resultado final. Se um dos dois for reordenado no futuro por engano, nada
acusa a regressão além do comportamento observado.

**Falso positivo conhecido e aceito**: `confirmsBooking`/`deniesBooking`
são regex sobre o texto do modelo, não sobre o LLM "entender" — uma
resposta criativa o suficiente (fora do vocabulário mapeado) pode escapar
das duas condições e não ser nem confirmada nem corrigida. Não observado em
produção até agora, mas é a mesma classe de risco que já mordeu 3 vezes
nesta auditoria (`"ss"` vs `"s"`, `"às"` vs `"das"`, `"h"` vs `"hrs"`).

---

## 6) Tools existentes (`lib/ai/tools.ts`, `TOOL_REGISTRY`)

| Tool | O que valida antes de agir |
|---|---|
| `get_business_hours` | — (leitura) |
| `search_knowledge_base` | — (leitura) |
| `get_customer_profile` | — (leitura, escopado ao `contactPhone`) |
| `update_customer_profile` | Só grava campos explicitamente informados |
| `get_customer_appointments` | Escopado ao `contactPhone` |
| `find_available_appointments` | Duração resolvida pelo backend, nunca pelo modelo |
| `create_appointment` | **`assertSameDay`** (dia do `startAt` == dia em discussão) → `assertBookable` (expediente/pausa/antecedência/sobreposição) |
| `confirm_appointment` | Resolve por `findNextAppointment` — **não valida posse explicitamente além do filtro de telefone da query subjacente** (ver §9, risco) |
| `reschedule_appointment` | `assertSameDay` → se >1 ativo e sem `appointmentId`, **recusa e lista** em vez de escolher → `assertBookable` |
| `cancel_appointment` | Exige `appointmentId` explícito; **trava de posse**: `appt.contactPhone !== ctx.contactPhone` → recusa |
| `request_human_handoff` | — (sempre disponível, sempre "sucesso") |

---

## 7) Estado atual da conversa

**Não existe um `ConversationState` estruturado** como o prompt-mestre
descreve (`intent/subIntent/service/date/time/appointmentId/
candidateAppointments/awaiting/lastQuestion/lastAssistantOffer/
pendingConfirmation/handoffState/operationState`). O que existe hoje:

- **`ConversationTask`** (Firestore, por conversa): `type` (3 valores),
  `state` (6 valores: `collect_service`, `collect_date`,
  `check_availability`, `offer_options`, `confirm`, `create_appointment`),
  `collectedData: Record<string, string | number>` — **só usa as chaves
  `date` e `serviceName` na prática**; `missingData: string[]` — **declarado
  mas não vi nenhum lugar que o popule ou leia** (candidato a código morto,
  não confirmado com certeza).
- **`Conversation.status`**: `"bot" | "handoff" | "human" | "closed"` — é o
  `handoffState` do prompt-mestre, mas simplificado a 3 estados úteis (não
  existe `OFFERED`/`ACCEPTED` como estados persistidos — ver §9).
- **Histórico de mensagens**: só texto (`role`, `text`, `at`), até 12 por
  conversa. **Nenhum dado estruturado atravessa duas mensagens** — nem
  `appointmentId` candidato, nem `startAt` calculado, nem qual foi a
  "última oferta" da Livia em forma de dado (só como texto que precisa ser
  relido).
- **`pendingTask` / fila de pendências do painel**: existe, mas é para o
  ATENDENTE HUMANO ver no painel, não é estado conversacional da Livia.

**Isso é a causa raiz confirmada de pelo menos 4 bugs corrigidos nesta
auditoria** (data errada, horário errado ao confirmar sem repetir, alvo
errado no cancelamento ambíguo, remarcação pegando o agendamento errado). O
padrão que se repete: alguma informação já resolvida em um turno (um
`startAt`, um `appointmentId`, uma data) não tem onde morar entre mensagens
além de texto solto — e cada vez que isso acontece, ou o modelo tem que
reconstruir (e erra), ou eu escrevo mais um parser determinístico específico
(`extractSingleTime` lendo a última mensagem da Livia, `matchCancelTarget`
lendo a lista de ativos contra o texto do cliente). Funcionou nos 4 casos,
mas é reativo — um `ConversationState` mais rico resolveria a CLASSE do
problema, não caso a caso.

---

## 8) Pontos onde o LLM decide fatos que deveriam ser determinísticos

| Onde | Decisão | Hoje é... | Deveria ser |
|---|---|---|---|
| `find_available_appointments` → confirmação de horário citado sem repetir a hora | Qual horário o "sim" confirma | Híbrida (extractSingleTime na última msg da Livia) | Já é determinística — ok |
| `confirm_appointment` | Qual agendamento confirmar | **LLM escolhe** (chama a tool sem alvo resolvido pelo backend antes) | Deveria seguir o mesmo padrão de `resolveCancellation`/reschedule: resolver alvo por código quando há ambiguidade |
| Correção de intenção em geral ("não, quarta às 15" depois de "terça às 14") | Qual campo foi corrigido, quais permanecem | **100% LLM** — não há parser de correção, o modelo reconstrói o pedido inteiro a cada turno a partir do texto | Deveria ter uma camada de "override por entidade" (§11/§12 do prompt-mestre) — não existe hoje |
| Handoff por irritação/pedido implícito | Se a mensagem justifica oferecer humano | LLM (correto — é interpretação de linguagem, não fato) | Manter no LLM |
| Multi-intenção numa mensagem só ("cancela o das 10 e remarca para as 14") | — | Não suportado; o loop de tools pode até tentar as duas, mas nada garante ordem/atomicidade | Ver §20 — documentar como fase futura |

O achado mais importante desta seção: **`confirm_appointment` é a única
ferramenta de escrita que não passa por uma resolução de alvo
determinística antes de executar.** `create_appointment` tem
`assertSameDay`; `reschedule_appointment` e `cancel_appointment` têm
resolução de alvo por código. `confirm_appointment` chama
`findNextAppointment` direto dentro da tool, sem o mesmo tratamento — com
múltiplos agendamentos ativos, o LLM pode estar "confirmando presença" no
agendamento errado sem que nada avise. **Não observado em produção ainda
nesta sessão**, mas é o mesmo formato exato do bug já corrigido em
remarcação (`396e80a`). Candidato forte a bug real ainda não descoberto.

---

## 9) Bugs encontrados (nesta leitura, ainda não corrigidos)

1. **`confirm_appointment` sem resolução de alvo** (§8 acima) — mesmo
   padrão do bug de remarcação já corrigido. Não reproduzido em produção
   nesta sessão, achado por leitura de código.
2. **`missingData: string[]` em `ConversationTask` é código morto,
   confirmado**: `grep` em todo `lib/` e `app/` mostra só duas escritas
   (`lib/ai/taskState.ts`, sempre `[]`) e a declaração de tipo — nenhuma
   leitura em lugar nenhum. Limpeza segura sempre que autorizada; citado
   aqui porque um `ConversationState` mais rico (§7/§10) deveria decidir
   se esse campo ganha uso real ou é removido, não continuar existindo
   sem função.
3. **Cancelamento em lote / multi-intenção**: já documentado como limitação
   conhecida (não é bug, é ausência de funcionalidade) — ver
   `docs/MODELO-ATENDIMENTO-LIVIA-2026-09-08.md` §10.
4. **Sem parser de "correção de intenção"**: quando o cliente corrige um
   campo só ("não, quarta às 15"), o sistema não tem uma camada dedicada —
   depende do LLM reconstruir a partir do texto corrido. Funciona na
   prática (não vi caso quebrado em produção), mas não é testável da forma
   como as outras camadas determinísticas são, e é exatamente o padrão que
   já quebrou 3 vezes antes de eu escrever um parser dedicado.

Nenhum destes 4 foi reproduzido com um caso real de produção falhando —
são achados de leitura estrutural, não bugs confirmados por sintoma
observado. Marco isso explicitamente porque a diferença importa: os bugs
das sessões anteriores só foram corrigidos DEPOIS de eu reproduzir com o
módulo real (`lib/scheduling.ts` + Firestore falso) no instante exato do
incidente — nunca só por leitura. Estes quatro ainda não passaram por essa
prova.

---

## 10) Causa raiz provável (padrão que atravessa os bugs já corrigidos hoje)

Não é um bug — é um **padrão arquitetural**. Toda vez que uma informação
resolvida (um horário, uma data, um `appointmentId`) precisa sobreviver de
um turno para o outro, ela não tem onde morar além de:
(a) `ConversationTask.collectedData` (só 2 chaves usadas), ou
(b) texto solto no histórico, que o modelo tem que reler e reinterpretar.

Cada vez que (b) acontece, existe uma janela para o modelo errar a
reconstrução — foi a causa raiz comum de: data errada ao confirmar sem
repetir dia, horário errado ao confirmar sem repetir minuto, alvo errado no
cancelamento ambíguo, agendamento errado na remarcação. A correção de cada
um foi um parser determinístico específico lendo a última mensagem
relevante — efetivo, mas não escala: cada novo tipo de informação que
precisar atravessar turnos vai pedir o mesmo tratamento sob medida de novo,
a menos que a causa estrutural (falta de um `ConversationState` mais rico)
seja endereçada.

---

## 11) Riscos de regressão

- **Confiança em regex/listas fechadas** (`readConfirmation`,
  `readHumanIntent`, `parseTimeSelection`, `deniesBooking`,
  `confirmsBooking`) é o ponto mais frágil do sistema hoje — 3 dos bugs
  desta auditoria vieram de uma variação de escrita não coberta. Qualquer
  fase futura que adicione vocabulário precisa de teste explícito por
  variação, não só "funciona no caso feliz".
- **Guards #4/#5 e #6 têm ordem que importa** (§5) sem teste que trave a
  ordem — risco silencioso numa refatoração futura.
- **`ConversationTask.collectedData` tipado como `Record<string, string |
  number>`** — qualquer expansão para um `ConversationState` mais rico
  (§7) exige decidir: estende esse tipo (risco de quebrar leitura de dado
  antigo já persistido em conversas ativas) ou migra para um campo novo em
  paralelo (mais seguro, mais trabalho).
- **`console.log` temporário ainda ativo**: a linha `tools` dentro de
  `"AI responded"` (`app/api/webhooks/whatsapp/route.ts`) continua no
  código — deveria ser removida quando as correções de agendamento forem
  consideradas estáveis (foi mantida de propósito até aqui, é
  `console.log`, não é payload/contrato — mas não é definitivo).

---

## 12) Plano de implementação por fases (proposto, aguardando autorização)

Seguindo a ordem do próprio prompt-mestre, adaptada ao que já foi feito:

- **FASE 0 — Auditoria**: este documento. Concluída.
- **FASE 1 — Bugs críticos**: já em grande parte concluída em sessões
  anteriores (handoff sem retorno, remarcação pegando alvo errado,
  cancelamento ambíguo, data/dia errados). O item novo desta auditoria que
  se qualificaria aqui é **`confirm_appointment` sem resolução de alvo**
  (§8/§9.1) — mas primeiro precisa ser REPRODUZIDO com um cenário real
  (múltiplos agendamentos ativos + "confirmo presença"), não corrigido só
  por suspeita de leitura.
- **FASE 2 — Contexto**: desenhar (não implementar ainda) um
  `ConversationState` mais rico que resolva a causa raiz do §10, em vez de
  continuar tratando sintoma por sintoma.
- **FASE 3 — Inteligência**: camada de correção de intenção (§11/§12 do
  prompt-mestre) — depende da Fase 2 existir primeiro (correção de campo
  precisa de algum lugar pra gravar "isto foi corrigido, mantenha o resto").
- **FASE 4 — Robustez**: observabilidade estruturada (§36 do prompt-mestre)
  — hoje só existe `console.log` textual; travar ordem dos guards com
  teste; investigar idempotência do loop de tools (§24 — não auditado a
  fundo ainda, ver limitação abaixo).
- **FASE 5 — Evolução**: multi-intenção, memória de preferências,
  reengajamento — como já estava documentado em
  `docs/MODELO-ATENDIMENTO-LIVIA-2026-09-08.md`.

**Não implementei nada disso.** Aguardando autorização por fase, como
pedido.

---

## 13) Alterações que NÃO devem ser feitas (Meta Review Freeze)

Nenhum item desta auditoria toca WhatsApp Cloud API, WABA, número,
Embedded Signup, permissões, templates, webhooks públicos, autenticação,
tokens, payloads externos, infraestrutura ou configuração de produção
relacionada à Meta. Todo o escopo encontrado (`ConversationState`,
correção de intenção, guards, observabilidade) vive inteiramente em
`lib/ai/*`, `lib/scheduling.ts` e no corpo de `app/api/webhooks/whatsapp/
route.ts` que já é modificado sem tocar no contrato do webhook (assinatura,
verificação, formato de resposta 200).

Nada encontrado nesta auditoria exige mudança de modelo/provider, dependência
externa nova, ou arquitetura de infra.

---

## 14) Testes existentes

**483 testes em 41 arquivos**, todos passando no momento desta auditoria.
Cobertura por área (arquivos relevantes):

- Data: `lib/ai/dateSelection.test.ts`, `lib/ai/weekdayDates.test.ts` (55+
  casos, incluindo a matriz completa pedida no prompt-mestre §9)
- Horário: cobertura espalhada em `lib/ai/confirmProposedTime.test.ts`,
  `lib/ai/bookingSelection.test.ts`, `lib/ai/reproDateBug.test.ts`
- Agendamento: `lib/ai/bookingSelection.test.ts`,
  `lib/ai/bookedDenial.test.ts`, `lib/ai/sameDayGuard.test.ts`
- Remarcação: `lib/ai/rescheduleAndOverflow.test.ts`,
  `lib/ai/rescheduleTarget.test.ts`
- Cancelamento: `lib/ai/cancelFlow.test.ts`,
  `lib/ai/cancelDeterministic.test.ts`, `lib/ai/cancelIntent.test.ts`,
  `lib/ai/cancelAmbiguous.test.ts`
- Handoff: `app/api/webhooks/whatsapp/route.handoff.test.ts`,
  `lib/ai/humanRequest.test.ts`
- Confirmação/negação: `lib/ai/confirmation.test.ts`
- Orquestração ponta a ponta com agenda real: `lib/ai/reproDateBug.test.ts`,
  `lib/ai/cancelAmbiguous.test.ts` (Firestore falso, sem mock de
  `lib/scheduling`)

**O que NÃO existe hoje**: nenhum teste de conversa **multi-turno completa**
simulando 4+ trocas em sequência verificando estado a cada passo (§35 do
prompt-mestre) — os testes existentes verificam 1-2 turnos por caso. Também
não existem **testes adversariais** compostos (§33: "sim, mas não cancela",
"terça não, quarta às 14" na mesma frase) — cada bug corrigido tem teste
para a FRASE exata que falhou, não para combinações adversariais
construídas de propósito.

---

## 15) Testes que precisam ser adicionados (antes de qualquer Fase 1 nova)

1. **`confirm_appointment` com múltiplos agendamentos ativos** — reproduzir
   primeiro se o alvo errado é de fato escolhido (transforma achado §8/§9.1
   de "suspeita" em "bug confirmado" ou descarta).
2. **Conversa multi-turno completa** (§35): pelo menos 2-3 cenários longos
   (agendar → mudar de ideia → remarcar → cancelar) verificando o estado
   da tarefa a cada mensagem, não só o resultado final.
3. **Testes adversariais compostos** (§33): frases com duas afirmações
   conflitantes na mesma mensagem — hoje o comportamento nesses casos é
   desconhecido, não só "sem teste".
4. **Ordem dos guards #4/#5 vs #6** (§5/§11): teste que fixaria a ordem
   atual como contrato, não como acidente de implementação.
5. **Idempotência do loop de tools** (§24 do prompt-mestre): não auditado
   a fundo nesta rodada — precisa de um teste dedicado (ex.: forçar o LLM
   mock a chamar `create_appointment` duas vezes no mesmo turno) antes de
   eu poder responder com confiança se existe proteção real.
