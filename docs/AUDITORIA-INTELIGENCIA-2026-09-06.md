# Auditoria da camada de inteligência da Livia — 06/09/2026

Estado: **Fases 1–3 concluídas (mapa, riscos, causa raiz). Nenhuma correção
de comportamento aplicada ainda.** As correções propostas estão na Fase 4,
para decisão antes da implementação.

Contexto: o app está em revisão da Meta. Esta auditoria opera sob **freeze**
— nada de integração Meta, WhatsApp Cloud API, WABA, número, templates,
permissões, Embedded Signup, webhooks (contrato), endpoints públicos,
autenticação ou configuração de produção.

---

## Fase 1 — Mapa do fluxo

Caminho de uma mensagem do cliente até a resposta:

| # | Etapa | Onde |
|---|---|---|
| 1 | POST do webhook, assinatura HMAC, parse | `app/api/webhooks/whatsapp/route.ts` |
| 2 | Resolve estabelecimento por `phone_number_id`; dedupe por `msg.id` | `route.ts` → `lib/repo.ts` |
| 3 | Carrega conversa + histórico (texto puro) | `loadConversation` |
| 4 | Persiste a mensagem do cliente **antes** de qualquer decisão | `appendMessage` |
| 5 | Portões: estabelecimento inativo, `status human/handoff` | `route.ts` |
| 6 | Atalho determinístico de confirmar/cancelar lembrete | `confirmCancelIntent` |
| 7 | Intenção (determinística), perfil do cliente, tarefa em andamento | `lib/ai/intent.ts`, `repo.ts` |
| 8 | **Camada determinística**: escolha de horário e cancelamento | `resolveTimeSelection`, `resolveCancellation` |
| 9 | Monta prompt (contexto de data, perfil, tarefa, resultado das etapas 8) | `buildSystemPrompt`, `nowLocal` |
| 10 | Loop de ferramentas com o LLM — **máx. 4 iterações** | `think()` |
| 11 | Guards de pós-processamento (7 travas) | `think()` |
| 12 | Envio, persistência da resposta, derivação de estado da tarefa | `sendText`, `deriveTaskState`, `derivePendingTask` |

**Observação estrutural mais importante do mapa:** entre uma mensagem e outra,
só sobrevive **texto**. As chamadas de ferramenta e seus resultados (incluindo
o `startAt` exato em epoch) vivem apenas dentro de uma execução de `think()`
(etapa 10, `messages`). O que persiste é `Message.text` e um `ConversationTask`
com `collectedData` limitado a `date` e `serviceName`. Toda vez que um valor
crítico precisa atravessar dois turnos, ou ele está nesses dois campos, ou o
modelo tem de **reconstruí-lo por conta própria** — que é a origem de metade
dos incidentes desta noite.

---

## Fase 2 — Achados classificados

| ID | Severidade | Origem | Achado |
|---|---|---|---|
| F1 | **CRÍTICO** | REGRA | Estouro do loop de ferramentas transfere para humano |
| F2 | **CRÍTICO** | REGRA | Remarcação pode criar agendamento duplicado |
| F3 | **CRÍTICO** | ESTADO | Oferecer humano == executar handoff; sem retorno |
| F4 | ALTO | PROMPT | Data depende do LLM; horário é determinístico |
| F5 | ALTO | REGRA | Guards por enumeração de frases (frágil por construção) |
| F6 | MÉDIO | ESTADO | `collectedData` guarda só `date` e `serviceName` |
| F7 | BAIXO | CONTEXTO | Painel rotula 07/09 como "hoje" sendo 06/09 |

---

## Fase 3 — Causa raiz

### F1 — Estouro do loop vira transferência (Caso 3 do escopo)

**Observado.** Rejane, 20:38, pede remarcação com "As 14h" e recebe
*"Vou chamar uma pessoa da equipe para te ajudar com isso, tudo bem? Já já
alguém te responde por aqui."*

**Causa raiz.** Essa frase existe em **um único lugar**: `brain.ts:968`, o
retorno após o `for (let i = 0; i < 4; i++)` terminar sem o modelo produzir
texto final. As outras seis mensagens de transferência usam *"pra te ajudar
com isso —"*; só esta usa *"para te ajudar com isso, tudo bem?"*. A assinatura
textual é a prova.

Ou seja: **o guard de incapacidade não disparou** (hipótese que eu levantei
antes e que estava errada), e o guard ampliado em `6fb1adb` não tem relação
com o caso. O que houve foi o modelo gastar as 4 iterações chamando
ferramentas — muito provavelmente tentando remarcar para um horário cuja data
ele calculou errado, levando recusa do backend e tentando de novo.

**Por que o sistema permitiu.** O estouro é tratado como falha irrecuperável e
transfere incondicionalmente, mesmo quando o turno tem informação suficiente
para responder (por exemplo: a última consulta de disponibilidade foi bem
sucedida). Transferir é a decisão mais cara possível — cala a Livia — e está
sendo tomada por um limite de iteração.

**Prompt ou código.** Código.

### F2 — Remarcação pode duplicar o agendamento

**Causa raiz.** `resolveTimeSelection` aceita tarefas dos dois tipos:

```ts
if (task.type !== "schedule_appointment" && task.type !== "reschedule_appointment") return null;
```

mas executa sempre a mesma ferramenta:

```ts
const result = await runTool("create_appointment", { serviceName, startAt }, toolCtx);
```

Numa tarefa de **remarcação**, o caminho determinístico portanto **cria um
segundo agendamento** em vez de mover o existente. O antigo permanece ativo.

**Estado.** Latente — não observado em produção ainda, mas alcançável por
qualquer cliente que peça remarcação e responda com um horário. É o mesmo
caminho que hoje funciona bem para agendamento novo.

**Prompt ou código.** Código.

### F3 — Oferta de humano é executada como transferência (Caso 4 do escopo)

**Observado.** Niltinho, 20:29. A Livia oferece: *"posso transferir você para
um atendente humano… Você gostaria disso?"*. O cliente responde **"n"**. A
Livia nunca mais responde.

**Causa raiz.** Três fatos combinados:

1. O prompt manda chamar `request_human_handoff` quando o cliente "demonstrar
   irritação" (`brain.ts:220`) — e ele tinha acabado de reclamar.
2. A ferramenta **executa ao ser chamada**: `handoffRequested = true`. Não
   existe distinção entre *perguntar se a pessoa quer um humano* e
   *transferir a pessoa agora*. O modelo perguntou; o sistema transferiu.
3. O webhook grava `status = "handoff"` e, a partir daí, toda mensagem nova
   cai no portão da etapa 5: é registrada, reabre a pendência, e a Livia fica
   em silêncio. A única saída é o botão "Devolver para Livia" no painel.

O "não" do cliente chegou quando a conversa já estava silenciada — ele nunca
teve como recusar.

**Distinções que o sistema não modela hoje:** sugestão de humano · pedido
explícito · handoff confirmado · handoff assumido por atendente (`human`) ·
conversa silenciada · retomada.

Importante: `handoff` (Livia parou, ninguém assumiu) e `human` (atendente
assumiu) **já são estados distintos**. Sair de `handoff` é seguro; sair de
`human` nunca pode ser, porque há uma pessoa digitando do outro lado. Isso
provavelmente dispensa campo novo no Firestore.

**Prompt ou código.** Código (máquina de estados). O prompt participa, mas
mudar só o prompt deixaria o mesmo buraco.

### F4 — Data no prompt, horário no código

**Causa raiz.** Assimetria. **Horário** tem parser determinístico
(`parseTimeSelection`) e é validado pelo backend. **Data** é resolvida pelo
modelo, com o prompt fornecendo `hoje`, `amanhã` e — desde `b169e0b` — as sete
próximas datas por nome de dia.

`b169e0b` reduz o erro, mas não muda a natureza: continua sendo o LLM fazendo
a correspondência. Não cobre "dia 8", "depois de amanhã", "semana que vem",
"08/09", "próxima terça". E não é verificável por teste, porque o resultado
depende do modelo.

**Consequência real.** A cliente pediu terça e foi agendada na segunda. E é a
suspeita mais provável do que alimentou o estouro de loop em F1.

**Prompt ou código.** Código — um `parseDateSelection` irmão do
`parseTimeSelection`, mantendo o contexto do prompt como reforço.

### F5 — Guards por enumeração de frases

**Causa raiz.** Vários pontos críticos decidem por lista de expressões:
`readConfirmation` (POSITIVE/NEGATIVE), `extractProposedTime`,
`deniesBooking`, `BOOKING_AFFIRMED`, `claimsIncapacity`, `looksLikeStalling`.

Só hoje, duas falhas de produção nasceram de buracos nessas listas: `"ss"`
estava coberto e `"s"` não; `"às 09:00"` estava coberto e `"das 13:00"` não.
Ambas passaram por toda a suíte de testes antes de falharem com cliente real.

Isto é um **risco de método**, não um bug isolado: cada correção por
enumeração aumenta a superfície da próxima falha. Onde a consequência é cara
(reservar, cancelar, calar a Livia), a decisão deveria vir de estado
verificado, não de correspondência de frase.

### F6 — `collectedData` guarda pouco

`collectFromTools` persiste apenas `date` e `serviceName`. O horário proposto,
o `startAt` escolhido e o agendamento em foco não atravessam turnos — daí a
necessidade de `extractProposedTime` reler o texto da própria Livia. Funciona,
mas é reconstrução de informação que o sistema já teve em mãos.

### F7 — "hoje" no painel

`/painel/agenda` rotulou 07/09 como "hoje" em 06/09. Cosmético, sem efeito no
agendamento (a agenda em si mostrou os dados certos). Fora do caminho crítico.

---

## Fase 4 — Correções propostas (não implementadas)

Ordem por risco de dano ao cliente, não por facilidade.

### P1 — Estouro do loop não transfere sozinho (F1)

Antes de transferir, aproveitar o que o turno já produziu: se houve consulta
de agenda bem-sucedida, responder com o dado real; se falta informação do
cliente, perguntar. Transferir só quando não houver nada aproveitável.

*Risco:* baixo. É um caminho de exceção; hoje ele sempre cala a Livia.
*Prova:* teste que força 4 rodadas de ferramentas e verifica que não há
handoff quando existe resultado utilizável.

### P2 — Remarcação usa a ferramenta de remarcação (F2)

No caminho determinístico, escolher `reschedule_appointment` quando a tarefa
for de remarcação. Corrige duplicação antes que aconteça com cliente real.

*Risco:* baixo-médio — muda o caminho de um fluxo que hoje "funciona" criando
o registro errado.
*Prova:* teste com tarefa de remarcação verificando que o agendamento antigo
foi movido e que **não** existe um segundo registro.

### P3 — Separar oferta de handoff da execução (F3)

Duas partes:
1. Uma oferta ("quer que eu chame alguém?") não executa transferência.
2. Estando em `handoff` (ninguém assumiu) e o cliente recusando de forma
   clara, a Livia retoma. **Nunca** a partir de `human`.

*Risco:* **o mais alto do lote** — muda quando a Livia fala e quando cala.
Merece deploy isolado e teste imediato em produção.
*Prova:* matriz de handoff (aceite, recusa, pedido explícito, ambíguo,
retomada, e a garantia de que `human` jamais é revertido).

### P4 — Camada determinística de data (F4, F5)

`parseDateSelection` cobrindo hoje/amanhã/depois de amanhã, nomes de dia,
"que vem", "dia N", `DD/MM`, `YYYY-MM-DD` — resolvendo contra o fuso do
estabelecimento, como `localToEpoch` já faz para horário. O contexto do prompt
permanece como reforço, não como fonte única.

*Risco:* médio — é código novo no caminho quente, mas puro e testável.
*Prova:* a matriz de datas pedida no escopo (todos os casos), mais combinações
dia + horário.

---

## Fora de escopo / requer aprovação

- **Campo novo no Firestore** para estados de handoff: provavelmente
  desnecessário (ver F3). Se a implementação de P3 provar o contrário, parar e
  pedir aprovação antes.
- **F7 (painel "hoje")**: cosmético, fora do caminho crítico.
- **Reduzir o prompt**: o escopo pede um prompt menor. Só faz sentido **depois**
  de P4 — enquanto a data depender do modelo, tirar contexto piora o resultado.
- **Trocar modelo, provider ou arquitetura**: não avaliado, proibido pelo
  escopo.

---

## Meta review — declaração

Nesta fase (auditoria + limpeza):

- **Nada** de integração Meta, WABA, número, templates, permissões, Embedded
  Signup ou autenticação foi alterado.
- **Contrato do webhook inalterado**: mesma verificação HMAC, mesmo 200,
  mesmos payloads.
- **Um endpoint público foi REMOVIDO**: `/api/whatsapp/diagnose`, criado hoje
  durante a revisão para diagnosticar o caso 131047. Sua pergunta já havia sido
  respondida (as mensagens estavam indo para o número de teste da Meta,
  `+1 555-140-1965`, e não para o número conectado). Remover reduz superfície
  durante o review.
- Removido também o log temporário `meta case 131047 — inbound identity`.
- **Mantido**: a linha de `tools` em `"AI responded"` — `console.log` dentro do
  webhook, sem efeito em contrato, payload ou resposta. É a única visibilidade
  de produção sobre qual `date`/`startAt` cada ferramenta recebe, e sai ao fim
  das correções de agendamento.

Suíte: **339 testes, todos passando**, antes e depois da limpeza.
