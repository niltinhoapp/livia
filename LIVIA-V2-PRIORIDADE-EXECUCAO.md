# Lívia V2 — Prioridade de Execução

## Status

Este documento complementa o `LIVIA-V2-ROADMAP.md` e define a ordem operacional atual das próximas Ordens de Trabalho.

O roadmap continua sendo a referência funcional da V2. Este arquivo existe para registrar a prioridade de execução sem reescrever o escopo já aprovado.

A V1 permanece em produção e nenhuma etapa abaixo autoriza alterar diretamente Meta, WABA, Embedded Signup, webhook, números, credenciais, variáveis de ambiente ou fluxos estáveis sem OT específica.

---

# Decisão principal

**Áudio não será tratado como melhoria tardia.**

Para atendimento por WhatsApp, áudio é comportamento normal do cliente. Por isso, a primeira evolução funcional da V2 após a fundação deve preparar a IA e o processamento de áudio juntos.

O objetivo é evitar uma V2 comercialmente mais avançada em CRM e cobrança enquanto o atendimento ainda depender apenas de texto.

---

# Ordem operacional atual

## V2.0 — Fundação CRM V2

Auditar e preparar contratos mínimos para evolução do CRM sem migração destrutiva.

Prioridades:

- preservar `Customer`, conversas, agenda, conhecimento, handoff e Coexistência atuais;
- mapear timeline, responsáveis, oportunidades, canais e eventos;
- manter evolução aditiva;
- não criar estruturas vazias sem uso imediato;
- preservar isolamento multi-tenant e dados existentes.

## V2.1 — IA + Áudio

A primeira entrega funcional da V2 deve unir a evolução controlada da camada de IA com suporte real a áudio.

Escopo alvo:

```text
Cliente envia áudio
        ↓
Webhook atual
        ↓
Identificar mídia
        ↓
Baixar mídia com segurança
        ↓
Transcrever
        ↓
Persistir mensagem + referência da mídia + transcrição
        ↓
Contexto normal da conversa
        ↓
AI Gateway
        ↓
Lívia interpreta
        ↓
Resposta normal
        ↓
CRM / timeline quando aplicável
```

A implementação deve considerar desde o início:

- AI Gateway centralizado;
- modelo de conversa configurável;
- modelo/função de transcrição desacoplado do restante do atendimento;
- fallback controlado;
- associação da transcrição à mensagem original;
- deduplicação e idempotência;
- limites de tamanho e tipo de mídia;
- download seguro e expiração quando aplicável;
- não registrar segredos ou URLs temporárias sensíveis em logs;
- preservar o fluxo de texto atual;
- nenhuma troca global de modelo sem benchmark e regressão;
- custo e latência por conversa;
- testes com áudio curto, longo, inaudível, inválido e duplicado;
- comportamento seguro quando a transcrição falhar.

O áudio deve entrar no mesmo histórico/contexto da conversa, não em um CRM paralelo.

## V2.2 — Billing da Lívia / Asaas

Depois da fundação e do primeiro avanço funcional de atendimento:

- `Plan`;
- `Subscription`;
- `Benefit`;
- trial/cortesia/desconto;
- integração Asaas desacoplada do domínio;
- webhooks idempotentes;
- suspensão e reativação dentro da Lívia;
- preservar dados e conexão Meta/WhatsApp.

## V2.3 — Imagem e documentos

Expandir multimídia após o fluxo de áudio estar estabilizado:

- imagem;
- análise multimodal quando necessária;
- documentos;
- limites de tipo/tamanho;
- armazenamento/expiração seguros;
- nenhuma interpretação visual tratada como verdade operacional sem validação adequada.

## V2.4 — CRM comercial + equipes + roteamento

- oportunidades;
- responsáveis;
- `TeamMember`;
- timeline unificada;
- roteamento por função, região, unidade ou especialidade;
- regras persistidas e auditáveis.

## V2.5 — Campanhas

- templates Meta;
- audiência;
- elegibilidade;
- fila/workers;
- status por destinatário;
- consentimento/opt-out;
- retorno da resposta para IA + CRM.

## V2.6 — Pagamentos no atendimento

Cobranças dos clientes finais separadas do billing SaaS da Lívia.

A IA nunca confirma pagamento por texto do cliente ou comprovante visual. Somente evento confiável do backend/provedor altera o estado financeiro.

## V2.7 — Múltiplos números oficiais

Vários `WhatsappChannel` por estabelecimento somente depois que o contrato de canal estiver estabilizado.

Cada canal deve manter isolamento de `phoneNumberId`, WABA, credenciais e estado, compartilhando CRM apenas quando pertencer ao mesmo estabelecimento.

## V2.8 — Automações

Follow-up, reativação, lembretes e jornadas sobre eventos reais e auditáveis.

---

# Regra para Claude e Codex

Antes de qualquer implementação, Claude deve auditar o estado real do `main` e propor arquitetura mínima.

Codex só implementa uma OT depois da arquitetura ser revisada/aprovada.

Fluxo padrão:

```text
Claude: auditoria/arquitetura
        ↓
revisão humana
        ↓
Codex: implementação mínima
        ↓
testes + typecheck + build
        ↓
PR + checks/preview
        ↓
merge somente verde
```

Interromper se houver:

- mudança destrutiva;
- alteração fora do escopo;
- risco para Meta/Coexistência;
- incompatibilidade de dados;
- teste vermelho;
- conflito;
- necessidade de variável/credencial de produção não prevista;
- risco de interromper o atendimento atual.

---

# Regra de prioridade

Se houver conflito entre a ordem de execução descrita no `LIVIA-V2-ROADMAP.md` e este documento, **esta prioridade operacional deve ser considerada para as próximas OTs até nova decisão registrada**.

O escopo funcional do roadmap permanece válido.
