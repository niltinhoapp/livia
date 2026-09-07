# Como a Livia atende hoje — checklist para revisão

Documento describing o **modelo de atendimento** (a camada de IA/decisão),
não a integração com WhatsApp/Meta — isso fica de fora de propósito, para
não interferir na revisão em andamento. Feito para você revisar, aprimorar,
e também mandar para outra IA analisar.

Modelo em uso hoje: **gpt-4o-mini** (env `LIVIA_MODEL`, com esse valor como
padrão). Chamado via function calling (`tools`), até 4 iterações de
ferramenta por mensagem.

---

## 1) A ideia central: o sistema decide fatos, o modelo decide palavras

Regra que atravessa todo o desenho: **quanto mais cara for a consequência de
errar, menos a decisão depende do modelo interpretar bem**. O LLM escreve a
mensagem; quem decide se um horário está livre, se um cancelamento é seguro,
se uma transferência deve acontecer — é código determinístico, testado.

Isso existe porque a versão anterior confiava demais no modelo para esses
fatos, e ele "alucinava" (dizia que um horário estava ocupado sem consultar
a agenda, inventava que não conseguia cancelar, etc.). Cada linha abaixo tem
uma história real por trás.

---

## 2) Fluxo de agendamento

1. Cliente diz o que quer (serviço + dia), em qualquer ordem/frase.
2. O sistema (não o modelo) lista os horários REALMENTE livres daquele dia
   — respeitando expediente, pausa (almoço), antecedência mínima
   (`leadHours`) e sobreposição com outros agendamentos.
3. Cliente escolhe um horário. Duas formas, ambas resolvidas por código:
   - Escolha explícita: "13", "13:00", "13h30", "às 14", "das 10 hrs".
   - Confirmação de um horário que a PRÓPRIA Livia propôs ("ss", "sim", "ok",
     "s" — sem repetir o horário).
4. O sistema tenta reservar de verdade ANTES de qualquer texto ser gerado.
   Se der certo, o modelo só formata a confirmação; se não, o motivo real
   (fechado, dentro do almoço, muito em cima da hora, ocupado) entra no
   prompt como fato, nunca como palpite do modelo.
5. Trava final: se a reserva foi criada e a resposta do modelo, por qualquer
   razão, NÃO confirmar isso claramente, o sistema substitui a resposta pela
   confirmação canônica. Nunca deixa passar um texto que negue uma reserva
   real.

**O que o modelo NUNCA decide sozinho:** se um horário está livre, qual é o
`startAt` exato de uma escolha explícita, se uma reserva foi criada.

**O que o modelo decide:** o tom da mensagem, como pedir informação
faltante, como reagir a uma recusa/mudança de ideia.

---

## 3) Interpretação de data e hora — 100% determinística

Dois módulos, sem IA:

- **Hora** (`lib/ai/timeSelection.ts`): entende "13", "13:00", "13h30",
  "13 e 30", "das 10 hrs", "16hrs" (sem espaço), horário mencionado dentro
  de uma frase maior ("terça as 14"). Recusa faixas/aproximações ("entre 14
  e 15h", "umas 2 da tarde") de propósito — decidir por conta própria nesses
  casos seria escolher pelo cliente.
- **Data** (`lib/ai/dateSelection.ts`): "hoje", "amanhã", "depois de
  amanhã", nomes de dia da semana ("terça", "terça-feira", "próxima
  terça" — sempre a PRÓXIMA ocorrência, nunca hoje nem passado), "dia 8",
  `08/09`, `08/09/2026`, ISO.

A data que o **cliente** disse numa mensagem sempre vence a que estava
"em memória" da conversa. E o sistema valida: se o horário escolhido cai
num dia diferente do que está em discussão, ele **recusa** em vez de
reservar (ou recusar) silenciosamente no dia errado.

---

## 4) Fluxo de remarcação

Mesma lógica de escolha de horário do agendamento, mas com uma trava extra:
se o cliente tem **mais de um** agendamento ativo, o sistema não escolhe
sozinho qual remarcar — ele se recusa e pergunta qual, listando os reais.
(Antes disso, o sistema sempre remarcava "o próximo agendamento na fila",
o que podia mover o horário errado silenciosamente.)

---

## 5) Fluxo de cancelamento

1. Cliente pede para cancelar (ou já está no meio desse fluxo).
2. Sistema consulta a agenda real do cliente.
3. Zero agendamentos → diz isso e oferece agendar.
4. Um agendamento → identifica e pede confirmação (nunca cancela direto).
5. Vários agendamentos → tenta casar o que o cliente já disse (horário,
   data, nome do serviço) contra a lista; se sobrar **exatamente um**
   candidato, resolve direto. Se sobrar mais de um ou nenhum, pergunta
   "qual desses?" listando todos.
6. Só cancela depois de uma confirmação explícita e inequívoca ("sim",
   "pode cancelar" — nunca um "ok" ambíguo em mensagem longa).

**Trava de posse:** um cancelamento só afeta agendamento do próprio
`contactPhone` que está conversando. Um cliente não consegue cancelar (nem
descobrir) o agendamento de outra pessoa citando nome ou telefone dela —
o sistema recusa e escala para atendente humano.

**Limitação conhecida, não implementada:** não existe cancelamento em
lote ("cancela todos"). O sistema resolve um agendamento por vez.

---

## 6) Confirmação e negação — leitura de "sim"/"não"

Lista fechada de expressões reconhecidas (`lib/ai/confirmation.ts`),
porque uma leitura frouxa demais já causou um cancelamento por engano no
passado ("não é isso" sendo lido como confirmação). Regra de projeto:
**negação sempre vence**, hedge ("acho que sim") nunca conta como sim, e
fora da lista reconhecida é sempre "unclear" — nunca um palpite.

Reconhecidos hoje como positivo: sim, s, ss, isso mesmo, exatamente,
confirmo, confirmado, pode confirmar, pode sim, quero sim, com certeza,
claro, manda ver, ok, beleza, 👍.
Como negativo: não, n, nunca, negativo, deixa pra lá, esquece, de jeito
nenhum, melhor não, prefiro não.

---

## 7) Pedido/recusa de atendente humano

- **Handoff** = a Livia identificou que precisa de humano e PAROU de
  responder sozinha, mas ninguém assumiu ainda.
- **Human** = um atendente de fato assumiu a conversa pelo painel.

A Livia oferece transferência quando o cliente pede explicitamente,
demonstra irritação, ou pede algo fora do escopo — isso continua sendo
decisão do modelo (é comportamento de linguagem, não fato verificável).

O que é determinístico:
- Se o cliente **recusar** um atendente (mesmo com um "n" ou "não" seco,
  desde que a última mensagem da Livia realmente tenha sido uma oferta), a
  conversa **volta a ser atendida pela Livia** automaticamente — nunca
  fica muda esperando alguém no painel sem o cliente saber que pode dizer
  não.
- Uma conversa em `human` (atendente já assumiu) **nunca** é retomada
  automaticamente — só manualmente, pelo painel.
- A resposta nunca pode **anunciar** uma transferência que não aconteceu
  de verdade ("vou transferir você") quando o sistema decidiu não
  transferir naquele turno.

---

## 8) Travas anti-alucinação (pós-processamento da resposta do modelo)

Depois que o modelo gera o texto, várias verificações rodam ANTES de
enviar ao cliente:

- **Desfecho inventado**: se o texto diz "ocupado"/"indisponível"/"fora do
  expediente" sem nenhuma ferramenta de agenda ter rodado naquele turno,
  o sistema força uma consulta real em vez de deixar passar.
- **Incapacidade inventada**: se o texto diz "não consigo cancelar/remarcar"
  mas a ferramenta existe e está habilitada, corrige — e se insistir,
  transfere de verdade (em vez de mentir e não transferir).
- **Enrolação**: "vou verificar", "um momento", "já te retorno" nunca são
  permitidos — a execução termina na resposta, não existe "depois".
- **Handoff não pode carregar promessa vazia**: se decidiu transferir, a
  frase não pode prometer verificação nenhuma.
- **Estouro do loop de ferramentas** (4 iterações sem resposta final): em
  vez de transferir cegamente, o sistema usa o que já foi produzido —
  reserva/remarcação feita, ou disponibilidade já consultada — antes de
  desistir e chamar humano.

---

## 9) Guardrails de conteúdo (configuráveis por estabelecimento)

- **Guardrail médico**: se ligado, a Livia nunca dá diagnóstico ou
  orientação clínica — só direciona para agendar ou falar com profissional.
- **Base de conhecimento**: a Livia só fala sobre o que está cadastrado
  (serviços, preços, horário, endereço, FAQ). Fora disso, instrução
  explícita para não inventar.
- **Ensine a Livia**: o estabelecimento pode cadastrar tom de voz,
  proibições e gatilhos extras de transferência — sempre como
  complemento, nunca podendo enfraquecer o guardrail médico.

---

## 10) O que NÃO está implementado (oportunidades reais de melhoria)

- Cancelamento em lote.
- Confirmar/gerenciar mais de um agendamento na mesma mensagem
  ("cancela o das 10 e remarca o das 14").
- Preferências aprendidas do cliente (profissional preferido, horário
  preferido, endereço frequente) existem no perfil, mas pouco usadas
  proativamente pela Livia hoje.
- Lembrete/confirmação de presença é reativo (manda mensagem, espera
  resposta curta) — não há reengajamento se o cliente não responder.
- Sem suporte a áudio, imagem ou localização — só texto.
- A base de conhecimento é texto livre por seção; não há busca semântica
  além do que entra inteiro no prompt.

---

## 11) O que fica DE FORA deste documento (de propósito)

Integração com WhatsApp Cloud API, webhook, autenticação, Embedded Signup,
WABA, templates, banco de dados/infra. Nada disso é "modelo de
atendimento" — é a camada de transporte, e está sob revisão da Meta.
