# Troca do modelo de IA — estado de prontidão

> Avaliação de 03/10/2026. Pergunta respondida: **o produto está pronto para
> usar um modelo mais avançado trocando só o modelo?**
>
> Ponto de partida: Production roda hoje **`gpt-5.6-terra`**.

## 1. Resposta curta

**Agora sim, e a troca é só da variável — mas nem todo modelo "mais avançado"
serve, e dois deles quebram tudo.**

A costura está no lugar certo: um único ponto de chamada
(`lib/ai/gateway.ts`), uma variável (`LIVIA_MODEL`), e os parâmetros por
família isolados em `lib/ai/openaiCompatibility.ts`. Nenhum fluxo de negócio
conhece o nome do modelo.

O que **não** era verdade antes desta avaliação: a camada de compatibilidade
reconhecia o modelo pelo **nome literal** (`model === "gpt-5.6-terra"`). Só o
modelo que já está em produção funcionava — qualquer outro dava 400 em **toda**
mensagem (§2).

O que continua **não** coberto por código nenhum: a prova de que o modelo novo
mantém os guardrails de atendimento. Essa prova é de uso real (§4).

## 2. As duas restrições do provider que decidem tudo

Nos modelos de raciocínio via `/v1/chat/completions`:

1. **Function tools exigem `reasoning_effort: "none"`.** Sem isso vem
   `400 — "Function tools with reasoning_effort are not supported for <modelo>
   in /v1/chat/completions"`. E vem **mesmo sem o parâmetro ser enviado**,
   porque o default desses modelos é `medium`.
2. **`temperature`/`top_p` são rejeitados enquanto o raciocínio está ativo.**
   Na família gpt-5.6, `reasoning_effort: "none"` os libera — é o que mantém
   válidos o `temperature: 0.4` do atendimento e o `0.2` do resumo. **Mas
   `gpt-6-sol` e `gpt-6-luna` são diferentes:** mantêm o raciocínio sempre
   ligado por dentro e rejeitam `temperature` em **todo** nível, inclusive
   `"none"` — *"This model doesn't support the temperature field."*

Todo turno da Lívia manda tools. Então apontar `LIVIA_MODEL` para um modelo
cuja restrição não esteja tratada produz:

```
400 do provider
  → classifyAiFailure → "provider_rejected"   (4xx = repetir não resolve)
  → shouldActivateLlmContingency → true JÁ NA 1ª TENTATIVA
  → toda conversa → handoff humano + "estou com uma instabilidade"
```

**Parada total da IA, em todos os tenants, com os testes 100% verdes** — porque
42 arquivos de teste mockam o `openai` e nunca exercitam a validação real do
endpoint.

| `LIVIA_MODEL` | Antes | Agora |
|---|---|---|
| `gpt-4o-mini` | ✅ | ✅ sem `reasoning_effort` |
| `gpt-5.6-terra` (atual) | ✅ | ✅ `none` + `temperature` |
| `gpt-5.6-sol`, `gpt-5.6-luna` | ❌ 400 em toda mensagem | ✅ `none` + `temperature` |
| `gpt-6-sol`, `gpt-6-luna` | ❌ 400 em toda mensagem | ✅ `none`, **sem `temperature`** |
| `gpt-6-astra`, `gpt-6.1-sol` | ❌ 400 silencioso → handoff | ❌ `UnsupportedModelError` explícito |
| nome desconhecido | request atual | request atual (sem piorar) |

`gpt-6-astra` e `gpt-6.1-sol` aceitam só `low..max`: **não existe** caminho para
function tools no Chat Completions. Usá-los é **migrar de endpoint** (Responses
API), não trocar de modelo — é OT própria, de porte bem maior que esta.

## 3. O que a troca entrega de fato

Por causa da restrição (1), a Lívia usa o modelo novo com **raciocínio
desligado**. O ganho é a qualidade de base da geração nova — melhor seguimento
de instrução, menos alucinação, português mais natural. O salto de planejamento
longo dos modelos de raciocínio **não** vem nesta troca; está atrás da
Responses API.

Fica um acoplamento latente a documentar: se alguém algum dia subir o esforço
de raciocínio, **dois** parâmetros quebram juntos — `temperature` (rejeitado) e
`max_completion_tokens: 500` (consumido pelos tokens de raciocínio, devolvendo
resposta vazia com `finish_reason: "length"`).

## 4. O que a troca NÃO valida — e por que o teste verde não é prova

A Lívia tem 2.839 testes, 206 arquivos. Destes, **42 mockam o `openai`**: eles
roteirizam a resposta do modelo e verificam o que o código faz com ela.

Isso cobre bem o que **não** muda com a troca — o tool loop, os guards de
mutação de agenda e pedido, o `operationId` semântico, a contingência, o
isolamento por tenant. Esses testes continuarem verdes é garantia **real** de
que a troca não mexeu em fluxo nenhum.

Mas eles **não** cobrem o que a troca de fato altera: o comportamento do
modelo. Nenhum teste prova que o modelo novo continua:

- não inventando preço, horário, disponibilidade ou pagamento;
- respeitando o handoff humano e o limite de escopo;
- não confirmando pedido sem confirmação explícita;
- não vazando contexto de demo/auditoria em tenant real;
- respondendo no formato curto de WhatsApp em vez de texto longo.

Cada um tem teste de regressão com a resposta **roteirizada**. Com modelo real,
a resposta é outra. Valida-se com uso real, não com `npm test`.

## 5. Opções a partir do `gpt-5.6-terra`

Preços por 1M de tokens (o `gpt-4o-mini` de referência: $0,15 / $0,60):

| Modelo | Input | Output | vs. terra | `temperature` |
|---|---|---|---|---|
| `gpt-5.6-terra` (atual) | $2 | $12 | — | ✅ 0,4 preservado |
| `gpt-5.6-sol` | ~$5 | ~$30 | ~2,5x mais caro | ✅ 0,4 preservado |
| **`gpt-6-sol`** | **$2** | **$10** | **mais barato** | ❌ perdido |
| `gpt-6-luna` | $0,10 | $0,50 | ~20x mais barato | ❌ perdido |

O fato que mais importa: **`gpt-6-sol` é mais capaz que o terra e custa menos**
que ele no output, com o mesmo input. A geração GPT-6 saiu em 22/09/2026 pela
metade do preço da 5.6, e o `gpt-6-sol` pontua ligeiramente acima do
`gpt-5.6-sol` nos índices de agente.

O preço disso é perder o `temperature: 0.4` — passa a valer o default do
provider (1,0). Para um bot cujo projeto inteiro depende de resposta contida e
previsível, **mais variabilidade é exatamente o risco que os guardrails do §4
existem para conter**. Por outro lado, o seguimento de instrução da geração
nova é melhor, o que empurra na direção oposta. Qual efeito ganha é questão
empírica — e barata de testar, porque é uma variável de ambiente.

## 6. Riscos operacionais (valem para qualquer troca)

**Custo multiplica.** O tool loop roda até **4 rodadas por turno**, e cada
rodada reenvia o system prompt inteiro mais todo o histórico. Sem cache de
prompt configurado no request, é input cheio toda vez.

**Latência.** `AI_COMPLETION_TIMEOUT_MS = 20_000`, `maxRetries: 0`, até 4
rodadas. O `POST` do webhook não declara `maxDuration`, então vale o default da
plataforma; com modelo mais lento, mais turnos estouram a janela do webhook e
caem no cron de recuperação (`maxDuration = 300`, de minuto em minuto). Não se
perde mensagem — o job é durável e idempotente —, mas a resposta chega com até
~1 min de atraso.

**Rollback.** `const MODEL = process.env.LIVIA_MODEL ?? "gpt-4o-mini"` é lido
**no carregamento do módulo**. Mudar a variável na Vercel exige redeploy para
valer. Não é rollback instantâneo.

**Granularidade.** Não existe roteamento por tenant nem canário: a troca é para
todos os estabelecimentos de uma vez. O `AiPurpose` do gateway
(`"reception" | "summary"`) é a fundação para isso, mas hoje só identifica a
origem da chamada — não escolhe modelo.

## 7. Recomendação

Seguindo o princípio do projeto (preservar produção → validar com uso real →
PR pequeno → deploy controlado):

1. **Testar `gpt-6-sol`** — é a única opção que melhora o modelo **e** reduz
   custo. Não ir direto para `gpt-5.6-sol`: custa ~2,5x o terra e o que separa
   as tiers da 5.6 são benchmarks de código e agente de longo horizonte, não
   atendimento conversacional.
2. Validar no **canal de demonstração/auditoria** antes dos tenants reais — já
   é isolado (`lib/ai/commercialContext.ts`) e exercita agenda, pedido,
   cardápio e handoff.
3. **Olhar especificamente a variabilidade** sem o `temperature: 0.4`: resposta
   mais longa que o formato WhatsApp, mais iniciativa do que o prompt autoriza,
   mais risco de inventar. É o único risco novo que o `gpt-6-sol` traz.
4. Se a variabilidade incomodar, o fallback é **`gpt-5.6-sol`** (mantém o 0,4,
   custa mais) ou ficar no terra.
5. Rodar as jornadas (`lib/ai/auditJourney.test.ts`, `demoOrderCompletion`,
   `bookingFunnel.regression`) e depois **repetir as mesmas jornadas por
   WhatsApp, à mão** — é o único passo que valida o §4.
6. Antes de ampliar para todos os tenants, considerar duas OTs próprias:
   roteamento de modelo por tenant (canário + rollback sem redeploy) e cache de
   prompt no request.

## 8. Fontes

Restrição de function tools e `reasoning_effort`:

- [litellm #33221 — função tools falham na família gpt-5.6 (sol/luna/terra)](https://github.com/BerriAI/litellm/issues/33221)
- [LibreChat #14355 — GPT-5.6 + function tools dá 400 sem `reasoning_effort` explícito](https://github.com/LibreChat-AI/LibreChat/issues/14355)
- [onyx #15008 — mesma mensagem de erro para `gpt-6-sol`](https://github.com/onyx-dot-app/onyx/issues/15008)
- [microsoft/simplechat #1606 — `gpt-6-astra` rejeita function tools em todo nível de esforço](https://github.com/microsoft/simplechat/issues/1606)
- [litellm #43910 — `gpt-6.1-sol` não aceita `none`/`minimal`](https://github.com/BerriAI/litellm/issues/43910)

Rejeição de `temperature` no GPT-6 Sol/Luna:

- [bifrost #7701 — GPT-6 Sol/Luna rejeitam `temperature`/`top_p` em todo esforço, inclusive `none`](https://github.com/maximhq/bifrost/issues/7701)
- [agdevhq/core-ai #202 — Sol e Luna mantêm o raciocínio ligado; `temperature`/`topP` seguem rejeitados](https://github.com/agdevhq/core-ai/pull/202)

Tiers, preços e benchmarks:

- [Azure OpenAI — modelos de raciocínio (GPT-6 Astra e GPT-5)](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning)
- [finout — GPT-6 Sol vs Luna: preço e desempenho](https://www.finout.io/blog/gpt-6-sol-vs-luna-pricing-performance-and-which-tier-to-use)
- [codersera — GPT-6 Sol & Luna: preços, benchmarks, vs Astra](https://codersera.com/blog/gpt-6-sol-luna-complete-guide-2026/)
- [MindStudio — tiers Sol, Terra e Luna do GPT-5.6](https://www.mindstudio.ai/blog/what-is-gpt-5-6-sol-terra-luna-explained)
