# Lívia — Estado Oficial do Projeto

> Atualizado em 26/09/2026. Este README descreve o que existe hoje em produção e separa claramente produto entregue de roadmap.

## 1. Visão atual

A Lívia é uma assistente virtual com IA para WhatsApp, operada pela Conect Web. O produto já está em produção e atende múltiplos tipos de comércio, com núcleo de atendimento, agenda, CRM, campanhas, áudio e uma vertical operacional de alimentação.

Princípio do projeto:

```text
preservar produção
→ validar com uso real
→ corrigir causa raiz
→ teste de regressão
→ PR pequeno
→ deploy controlado
```

Não reescrever fluxos estáveis apenas para preparar funcionalidades futuras.

## 2. Stack e produção

- Next.js 14 + TypeScript + Tailwind;
- Firebase Authentication + Firestore;
- Vercel;
- Meta WhatsApp Business Platform / Cloud API;
- Coexistência com WhatsApp Business App;
- OpenAI para inteligência/transcrição/voz;
- Asaas para billing da Lívia;
- arquitetura multi-tenant.

## 3. WhatsApp / Meta

Já implementado e validado:

- WhatsApp oficial via Meta;
- Embedded Signup;
- Coexistência;
- recebimento e envio;
- classificação de eventos do webhook;
- deduplicação;
- echo/history/app-state fora do pipeline normal da IA;
- handoff humano;
- isolamento por estabelecimento;
- conexão e dados preservados em desconexões seguras.

Não alterar Meta, WABA, Coexistência, webhook ou ownership sem necessidade comprovada.

## 4. Atendimento e IA

A Lívia já possui:

- atendimento conversacional;
- base de conhecimento configurável por estabelecimento;
- memória/contexto;
- ferramentas internas;
- regras para não inventar preço, agenda, disponibilidade ou pagamento;
- handoff humano;
- conversas e inbox;
- CRM;
- dashboard;
- respostas curtas e orientadas ao contexto.

### Áudio

Áudio está operacional em produção:

```text
WhatsApp recebe áudio
→ backend baixa a mídia
→ transcreve
→ texto entra no mesmo pipeline da conversa
→ IA responde
→ quando habilitado, resposta pode voltar em áudio
```

Conteúdo estruturado/visual — por exemplo cardápio, listas de horários e resumos estruturados — pode ser forçado para texto mesmo quando a entrada foi áudio. Isso evita sintetizar listas longas em voz. A regra entrou em produção no commit `96f73c8`.

Imagem/documento recebido não deve ser tratado como verdade operacional apenas por interpretação da IA.

## 5. Agenda

Operacional:

- consulta de disponibilidade;
- criação;
- remarcação;
- cancelamento;
- prevenção de conflito;
- interpretação de datas/horários;
- integração com o fluxo conversacional.

A IA nunca deve confirmar agendamento sem resultado real da ferramenta/backend.

## 6. CRM e painel

Já existem:

- clientes;
- conversas;
- histórico;
- CRM;
- funil/oportunidades;
- dashboard;
- handoff;
- conhecimento;
- agenda;
- campanhas;
- pedidos/cardápio;
- configurações operacionais.

Métricas devem vir de dados persistidos, não de texto gerado pela IA.

## 7. Campanhas

Campanhas já deixaram de ser apenas roadmap.

Estado atual:

- criação de campanha;
- contatos;
- templates Meta aprovados;
- seleção de template;
- envio real pela plataforma oficial;
- histórico/status de campanha;
- limite comercial do período gratuito tratado no produto;
- resposta do destinatário retorna ao fluxo normal da Lívia.

Campanhas devem respeitar regras da Meta, elegibilidade, consentimento/opt-out e cobrança aplicável. Não usar automação de WhatsApp Web como substituto da API oficial.

## 8. Vertical Alimentação

A frente de restaurantes/lanchonetes/delivery está operacional em produção.

Entregue:

- F1 — correções de base do catálogo/pedidos;
- F2 — configuração de pedidos no painel;
- F3 — cardápio, PIX e tom conversacional;
- F4 — robustez do carrinho/tool loop;
- F5 — resumo canônico + confirmação explícita;
- F6 — máquina de estados operacionais e histórico append-only;
- F7 — notificações automáticas de status;
- F8 — horários próprios de pedidos, inclusive overnight.

Capacidades atuais incluem:

- categorias/produtos;
- variações/adicionais;
- carrinho persistido;
- cálculo backend;
- entrega/retirada;
- taxa;
- forma de pagamento;
- resumo e confirmação;
- estados operacionais;
- notificações;
- horários de pedido;
- bloqueio de novos drafts fora do horário;
- painel de pedidos.

Pagamento online do pedido do cliente final continua domínio separado do billing SaaS da Lívia e não deve ser confundido com ele.

## 9. Billing da Lívia

O billing SaaS usa Asaas.

Fluxo implementado:

```text
/painel/plano
→ identificação CPF/CNPJ
→ customer idempotente
→ subscription
→ primeira cobrança
→ PIX / QR Code / copia-e-cola
→ webhook Asaas
→ billingStatus
```

Há state machine, idempotência e processamento de webhook. O controle comercial e os gates devem continuar sendo auditados antes de qualquer mudança que possa suspender atendimento. Nunca desconectar Meta/WhatsApp apenas por cobrança.

## 10. Prospecting / Demo

Existe canal interno separado para prospecção Revenue e demonstração:

- `revenue` preserva o tenant de prospecção;
- `demo` usa tenant de demonstração dedicado;
- endpoint interno seleciona explicitamente o canal;
- autorização Demo exige estabelecimento configurado + sessão Prospect válida + estado permitido + lead correspondente;
- não é permitido escolher establishment arbitrário.

A demonstração pode executar ações reais controladas no ambiente Demo, marcadas como `mode: "demo"`, sem produzir efeitos comerciais/operacionais reais indevidos.

Fluxo comercial atual:

```text
primeiro contato humano/manual
→ prospect responde
→ Lívia assume
→ demonstra capacidade na própria conversa
→ interesse
→ convite para experimentar o produto
```

A demonstração por áudio é parte importante desse fluxo, mas conteúdo estruturado deve permanecer legível em texto.

## 11. Segurança e concorrência

Preservar:

- isolamento multi-tenant;
- dedupe por mensagem;
- idempotência de mutações;
- leases/revalidação antes de ações críticas;
- ownership;
- tokens cifrados;
- ausência de segredos em logs;
- fail-closed em fronteiras administrativas;
- ações críticas determinadas pelo backend.

## 12. Estado de qualidade / CI

Produção pode estar saudável mesmo quando um check de CI falha por problema preexistente de ambiente de teste. Não mascarar isso.

Regra:

- distinguir falha preexistente em `main` de regressão criada por PR;
- não corrigir CI incidentalmente dentro de uma feature sem escopo aprovado;
- documentar a causa e tratar em PR próprio.

## 13. Documentação

Documentos vivos:

- `README.md` — estado oficial atual;
- `FOCO-OPERACIONAL.md` — checklist de operação;
- `LIVIA-V2-PRIORIDADE-EXECUCAO.md` — próximas prioridades;
- `LIVIA-V2-ROADMAP.md` — direção futura;
- `MVP-AUDIO.md` — arquitetura e estado de áudio;
- `docs/CAMPANHAS.md` — campanhas;
- `docs/v2-alimentacao/README.md` — vertical Alimentação;
- `COEXISTENCE_ROADMAP.md` — histórico/arquitetura de Coexistência.

Auditorias datadas em `docs/AUDITORIA-*.md` são registros históricos. Não devem ser reescritas para parecer atuais.

## 14. Regra para agentes

Claude, Codex e outros agentes devem partir da `main` remota atualizada.

```text
auditar estado real
→ escopo mínimo
→ branch isolada
→ implementar
→ testes relevantes
→ typecheck/build quando aplicável
→ PR
→ comparar falhas com main
→ merge/deploy controlado
```

Não assumir que documentação antiga representa o estado atual quando o código/produção já avançaram.

## Direção

A Lívia não é mais apenas uma recepcionista com agenda. Hoje o produto combina atendimento, voz, CRM, campanhas e operação de pedidos no WhatsApp. A evolução deve continuar incremental, usando o backend como fonte de verdade e preservando o que já está validado em produção.
