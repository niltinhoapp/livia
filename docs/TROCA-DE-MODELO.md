# Troca do modelo de IA — estado de prontidão

> Avaliação de 03/10/2026. Pergunta respondida: **o produto está pronto para
> usar um modelo mais avançado trocando só o modelo?**

## 1. Resposta curta

**Arquiteturalmente sim; operacionalmente só depois de validar com uso real.**

A costura existe e está no lugar certo: há **um único ponto de chamada ao
modelo** (`lib/ai/gateway.ts`), o modelo vem de **uma variável**
(`LIVIA_MODEL`) e os parâmetros por família ficam isolados em
`lib/ai/openaiCompatibility.ts`. Nenhum fluxo de negócio conhece o nome do
modelo.

O que **não** era verdade antes desta avaliação: a camada de compatibilidade
comparava o modelo pelo **nome literal** (`model === "gpt-5.6-terra"`). Só
aquele nome funcionava. Qualquer outro modelo avançado em `LIVIA_MODEL`
causaria 400 em **toda** mensagem (ver §2). Isso foi corrigido — agora o
reconhecimento é por família.

O que continua **não** coberto por código nenhum: a prova de que o modelo novo
mantém os guardrails de atendimento. Essa prova é de uso real, não de teste
automatizado (§4).

## 2. O que quebrava na troca ingênua (corrigido)

A OpenAI impõe, nos modelos de raciocínio via `/v1/chat/completions`:

1. **Function tools exigem `reasoning_effort: "none"`.** Sem isso o provider
   devolve `400 — "Function tools with reasoning_effort are not supported for
   <modelo> in /v1/chat/completions"`. E devolve **mesmo sem o parâmetro ser
   enviado**, porque o default desses modelos é `medium`.
2. **`temperature`/`top_p` são rejeitados enquanto o raciocínio está ativo.**
   Com `reasoning_effort: "none"` voltam a ser aceitos — é o que mantém
   válidos o `temperature: 0.4` do atendimento e o `0.2` do resumo.

Todo turno da Lívia manda tools. Então, antes da correção, apontar
`LIVIA_MODEL` para `gpt-5.6-sol` (a tier mais capaz) produziria:

```
400 do provider
  → classifyAiFailure → "provider_rejected"
  → shouldActivateLlmContingency(…) === true JÁ NA 1ª TENTATIVA
  → toda conversa vira atendimento humano + "estou com uma instabilidade"
```

Ou seja: **parada total da IA em todos os tenants, em todas as mensagens**, com
os testes 100% verdes — porque 42 arquivos de teste mockam o `openai` e nunca
exercitam a validação real do endpoint.

A correção generaliza o reconhecimento por família e falha explícito nos
modelos sem caminho possível:

| `LIVIA_MODEL` | Antes | Agora |
|---|---|---|
| `gpt-4o-mini` (padrão) | ✅ | ✅ sem `reasoning_effort` |
| `gpt-5.6-terra` | ✅ | ✅ |
| `gpt-5.6-sol`, `gpt-5.6-luna` | ❌ 400 em toda mensagem | ✅ `reasoning_effort: "none"` |
| `gpt-6-sol`, `gpt-6-luna` | ❌ 400 em toda mensagem | ✅ `reasoning_effort: "none"` |
| `gpt-6-astra`, `gpt-6.1-sol` | ❌ 400 silencioso → handoff | ❌ `UnsupportedModelError` explícito |
| nome desconhecido | request atual | request atual (sem piorar) |

`gpt-6-astra` e `gpt-6.1-sol` aceitam só `low..max` de esforço: **não existe**
caminho para function tools no Chat Completions. Usá-los é **migrar de
endpoint** (Responses API), não trocar de modelo — é outra OT, de porte
bem maior que esta.

## 3. O que a troca entrega de fato

Importante para não criar expectativa errada: por causa da exigência (1), a
Lívia usa o modelo novo com **raciocínio desligado**. O ganho é a qualidade de
base da geração nova — melhor seguimento de instrução, menos alucinação,
português mais natural. O salto de planejamento longo dos modelos de
raciocínio **não** vem nesta troca; ele está atrás da Responses API.

Isso também cria um acoplamento latente a documentar: se alguém algum dia
subir o esforço de raciocínio, **dois** parâmetros passam a quebrar juntos —
`temperature` (rejeitado) e `max_completion_tokens: 500` (consumido pelos
tokens de raciocínio, devolvendo resposta vazia com `finish_reason: "length"`).

## 4. O que a troca NÃO valida — e por que o teste verde não é prova

A Lívia tem 2.833 testes, 206 arquivos. Destes, **42 mockam o `openai`**: eles
roteirizam a resposta do modelo e verificam o que o código faz com ela.

Isso cobre muito bem o que **não** muda com a troca — o tool loop, os guards de
mutação de agenda e pedido, o `operationId` semântico, a contingência, o
isolamento por tenant. Esses testes continuarem verdes é uma garantia **real**
de que a troca não mexeu em fluxo nenhum.

Mas eles **não** cobrem o que a troca de fato altera: o comportamento do
modelo. Nenhum teste prova que o modelo novo continua:

- não inventando preço, horário, disponibilidade ou pagamento;
- respeitando o handoff humano e o limite de escopo;
- não confirmando pedido sem confirmação explícita;
- não vazando contexto de demo/auditoria em tenant real;
- respondendo no formato curto de WhatsApp em vez de texto longo.

Cada um desses tem um teste de regressão com a resposta **roteirizada**. Com
modelo real, a resposta é outra. Isso se valida com uso real, não com `npm test`.

## 5. Riscos operacionais da troca

**Custo** — por 1M tokens, comparado ao `gpt-4o-mini` ($0,15 / $0,60):

| Modelo | Input | Output | Fator aprox. (in/out) |
|---|---|---|---|
| `gpt-5.6-luna` | $1 | $6 | ~7x / ~10x |
| `gpt-5.6-terra` | $2,50 | $15 | ~17x / ~25x |
| `gpt-5.6-sol` | $5 | $30 | ~33x / ~50x |

E multiplica: o tool loop roda até **4 rodadas por turno**, e cada rodada
reenvia o system prompt inteiro mais todo o histórico. Sem cache de prompt
configurado no request, é input cheio toda vez. Para um produto multi-tenant de
WhatsApp, **este é o risco de negócio principal** — maior que o técnico.

**Latência** — `AI_COMPLETION_TIMEOUT_MS = 20_000`, `maxRetries: 0`, até 4
rodadas. O `POST` do webhook não declara `maxDuration`, então vale o default da
plataforma; com modelo mais lento, mais turnos estouram a janela do webhook e
caem no cron de recuperação (`maxDuration = 300`, de minuto em minuto). Não se
perde mensagem — o job é durável e idempotente —, mas a resposta chega com até
~1 min de atraso.

**Rollback** — `const MODEL = process.env.LIVIA_MODEL ?? "gpt-4o-mini"` é lido
**no carregamento do módulo**. Mudar a variável na Vercel exige redeploy para
valer. Não é rollback instantâneo.

**Granularidade** — não existe roteamento por tenant nem canário: a troca é
para todos os estabelecimentos de uma vez. O `AiPurpose` do gateway
(`"reception" | "summary"`) é a fundação para isso, mas hoje só identifica a
origem da chamada — não escolhe modelo.

## 6. Recomendação

Seguindo o princípio do projeto (preservar produção → validar com uso real →
PR pequeno → deploy controlado):

1. **Não** trocar direto para `gpt-5.6-sol` em produção. O ganho sobre `terra`
   é marginal para atendimento conversacional (os benchmarks que separam as
   tiers são de código e agente de longo horizonte, não deste caso de uso), e o
   custo é ~2x o do `terra`.
2. Começar por **`gpt-5.6-terra`**, que já era o único caminho suportado e
   continua sendo o melhor custo/qualidade da família.
3. Validar no **canal de demonstração/auditoria** antes dos tenants reais — ele
   já é isolado (`lib/ai/commercialContext.ts`) e exercita agenda, pedido,
   cardápio e handoff.
4. Rodar a bateria de jornadas (`lib/ai/auditJourney.test.ts`,
   `demoOrderCompletion`, `bookingFunnel.regression`) e depois **repetir as
   mesmas jornadas por WhatsApp, à mão**, com o modelo novo — é o único passo
   que valida o §4.
5. Olhar custo/token real por conversa antes de ampliar.
6. Antes de ampliar para todos os tenants, considerar duas OTs próprias:
   roteamento de modelo por tenant (canário + rollback sem redeploy) e cache de
   prompt no request.

## 7. Fontes

- [litellm #33221 — function tools falham na família gpt-5.6 (sol/luna/terra)](https://github.com/BerriAI/litellm/issues/33221)
- [LibreChat #14355 — GPT-5.6 + function tools dá 400 sem `reasoning_effort` explícito](https://github.com/LibreChat-AI/LibreChat/issues/14355)
- [microsoft/simplechat #1606 — `gpt-6-astra` rejeita function tools em todo nível de esforço](https://github.com/microsoft/simplechat/issues/1606)
- [Azure OpenAI — modelos de raciocínio (GPT-6 Astra e GPT-5)](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning)
- [MindStudio — tiers Sol, Terra e Luna do GPT-5.6](https://www.mindstudio.ai/blog/what-is-gpt-5-6-sol-terra-luna-explained)
- [tech-insider — comparativo de preço Sol vs Terra vs Luna](https://tech-insider.org/gpt-5-6-sol-vs-terra-vs-luna-2026/)
