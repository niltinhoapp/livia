# Lívia — Foco Operacional

## Missão desta fase

**Colocar a Lívia trabalhando com clientes reais, preservar o que já funciona e evoluir a V2 sem interromper produção.**

O `README.md` contém a direção oficial. O `LIVIA-V2-ROADMAP.md` contém a evolução planejada.

---

# 1. Estado atual

Já está validado:

- Meta aprovada;
- WhatsApp oficial funcionando;
- Coexistência funcionando com cliente real em portfólio separado;
- webhook e resposta E2E funcionando;
- agenda, conhecimento, CRM e handoff existentes;
- produção ativa na Vercel.

A fase "aguardando aprovação da Meta" terminou.

Não alterar Meta/Coexistência sem necessidade real.

---

# 2. Regra principal

Uma alteração só entra agora quando resolver diretamente:

- estabilidade;
- venda;
- ativação;
- atendimento;
- agenda/operação;
- cobrança;
- CRM necessário para V2;
- erro real de produção.

Caso contrário: backlog.

---

# 3. Checklist técnico antes de qualquer OT

- [ ] conferir `main` remoto;
- [ ] confirmar commit/deploy em produção;
- [ ] confirmar que não existe PR conflitante;
- [ ] mapear arquivos e contratos afetados;
- [ ] criar branch isolada;
- [ ] não alterar produção diretamente;
- [ ] rodar testes relevantes;
- [ ] rodar suíte completa quando aplicável;
- [ ] rodar TypeScript;
- [ ] rodar build;
- [ ] abrir PR;
- [ ] validar checks/preview;
- [ ] merge somente com verde.

---

# 4. Atendimento real

- [ ] mensagem chega ao webhook;
- [ ] estabelecimento correto é identificado;
- [ ] conversa correta é carregada;
- [ ] resposta é enviada uma única vez;
- [ ] mensagem fica registrada;
- [ ] não existe resposta cruzada entre tenants;
- [ ] echo/history/app-state não entram no pipeline normal da IA;
- [ ] contexto permanece correto.

---

# 5. Conhecimento

Testar:

- [ ] preço cadastrado;
- [ ] horário;
- [ ] endereço;
- [ ] serviço;
- [ ] pergunta não cadastrada;
- [ ] pergunta ambígua;
- [ ] conversa encerrada/reação simples.

Esperado: usar fonte real, não inventar e não prolongar conversa sem necessidade.

---

# 6. Agenda

- [ ] criar;
- [ ] consultar;
- [ ] confirmar;
- [ ] remarcar;
- [ ] cancelar;
- [ ] interpretar hoje/amanhã/dia da semana corretamente;
- [ ] consultar disponibilidade real;
- [ ] não confundir horário livre com agendamento existente;
- [ ] não prometer verificação futura inexistente.

---

# 7. Handoff

- [ ] cliente pede humano;
- [ ] estado muda realmente;
- [ ] IA para de responder;
- [ ] humano consegue assumir;
- [ ] humano consegue devolver para IA;
- [ ] histórico permanece íntegro;
- [ ] responsável fica registrado quando aplicável.

---

# 8. CRM atual

- [ ] cliente correto;
- [ ] nome/telefone corretos;
- [ ] intenção coerente;
- [ ] resumo não inventa;
- [ ] dashboard deriva de dados reais;
- [ ] funil não ultrapassa 100%;
- [ ] conversão não é inflada por duplicações.

---

# 9. Abertura controlada

Antes de aquisição em escala:

- [x] separar `panelAccess`;
- [ ] separar `whatsappAccess`;
- [ ] separar `trialStatus`;
- [ ] separar `subscriptionStatus`;
- [ ] bloquear conexão também no backend;
- [ ] preservar clientes já autorizados;
- [ ] preparar lista de espera;
- [ ] acompanhar primeiras empresas de perto.

Firebase Authentication identifica a conta; `panelAccess` é a autorização
server-side do painel; `whatsappBeta` permanece a autorização independente
para conectar WhatsApp durante a coorte controlada.

Provisionar, conceder ou revogar `panelAccess` exige um platform admin vindo da
sessão Firebase e presente em `PANEL_ADMIN_UIDS` (server-only). A fronteira fica
inativa/fail-closed enquanto essa configuração não existir em um ambiente. Ela
não concede vaga de WhatsApp e uma revogação não altera a conexão existente.

---

# 10. Billing Asaas

Primeira frente estrutural da V2.

- [ ] auditar modelo atual de usuário/estabelecimento;
- [ ] desenhar `Plan`;
- [ ] desenhar `Subscription`;
- [ ] desenhar `Benefit`;
- [ ] suportar desconto/cortesia sem alterar preço-base;
- [ ] integrar sandbox Asaas;
- [ ] checkout/assinatura;
- [ ] webhooks idempotentes;
- [ ] pagamento aprovado libera acesso;
- [ ] inadimplência suspende dentro da Lívia;
- [ ] reativação restaura acesso;
- [ ] cancelamento preserva dados;
- [ ] nunca desconectar Meta/WhatsApp por cobrança.

---

# 11. IA V2

Não trocar modelo diretamente em produção sem benchmark.

- [ ] localizar todas as chamadas atuais de IA;
- [ ] centralizar configuração em um AI Gateway;
- [ ] preservar tools/contracts;
- [ ] criar suíte de conversas reais;
- [ ] comparar modelo atual x candidato;
- [ ] medir custo por conversa;
- [ ] medir latência;
- [ ] validar agenda;
- [ ] validar handoff;
- [ ] validar conhecimento;
- [ ] validar multimodal futuramente;
- [ ] liberar por rollout controlado.

Candidato inicial para benchmark: **GPT-5.6 Terra**.

Escalonamento futuro de casos complexos pode usar **GPT-5.6 Sol**.

---

# 12. Fundação CRM V2

Preparar sem criar estrutura vazia desnecessária.

- [ ] timeline de eventos;
- [ ] oportunidades;
- [ ] pedidos;
- [ ] pagamentos;
- [ ] campanhas;
- [ ] responsáveis;
- [ ] equipes;
- [ ] canais/números;
- [ ] auditoria de mudanças críticas.

As entidades devem surgir conforme cada OT entra.

---

# 13. Equipes e múltiplos números

Dois conceitos independentes:

## Vários números oficiais

- [ ] estabelecimento pode possuir vários `WhatsappChannel`;
- [ ] cada canal tem `phoneNumberId` próprio;
- [ ] webhook roteia por número;
- [ ] CRM pode permanecer compartilhado;
- [ ] isolamento de credenciais por canal.

## Um número oficial + vários contatos internos

- [ ] diretório `TeamMember`;
- [ ] corretor/vendedor/técnico/gerente;
- [ ] papel;
- [ ] telefone;
- [ ] especialidade;
- [ ] região/unidade;
- [ ] disponibilidade/estado quando necessário;
- [ ] responsável pela oportunidade;
- [ ] handoff/encaminhamento;
- [ ] logs de roteamento.

Não misturar funcionário com cliente.

---

# 14. Multimídia

- [ ] áudio recebido;
- [ ] download seguro;
- [ ] transcrição;
- [ ] associação com mensagem original;
- [ ] interpretação pela IA;
- [ ] imagem recebida;
- [ ] análise multimodal;
- [ ] limites de tamanho/tipo;
- [ ] armazenamento/expiração seguros;
- [ ] não transformar interpretação visual em verdade operacional sem validação.

---

# 15. Campanhas

Só implementar depois da fundação necessária.

- [ ] templates Meta;
- [ ] audiência;
- [ ] segmentação;
- [ ] elegibilidade;
- [ ] consentimento/opt-out;
- [ ] fila;
- [ ] workers;
- [ ] status por destinatário;
- [ ] webhook de status;
- [ ] resposta volta para conversa normal;
- [ ] CRM registra origem da campanha;
- [ ] campanha pode gerar oportunidade.

---

# 16. Vendas e pagamentos no WhatsApp

- [ ] intenção comercial;
- [ ] oportunidade;
- [ ] produto/serviço real;
- [ ] valor vindo de fonte oficial;
- [ ] order;
- [ ] cobrança;
- [ ] link/PIX quando permitido;
- [ ] webhook Asaas;
- [ ] confirmação de pagamento pelo backend;
- [ ] CRM atualizado;
- [ ] venda concluída.

A IA nunca confirma pagamento por texto ou comprovante enviado pelo cliente.

---

# 17. Ordem de implementação

Ordem padrão:

```text
V1 estável
→ controle de acesso
→ billing Asaas
→ AI Gateway + benchmark
→ fundação CRM V2
→ multimídia
→ equipes e roteamento
→ campanhas
→ pagamentos de clientes finais
→ múltiplos números oficiais
→ automações
```

A ordem pode mudar por necessidade comprovada de cliente, mas nunca por entusiasmo com feature.

---

# 18. Regra para bugs

```text
Mensagem real
+ estado real
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

---

# 19. Regra para Claude/Codex

Cada OT deve ter uma única fronteira clara.

Claude pode auditar arquitetura e preparar a Ordem de Trabalho.

Codex pode implementar, testar, abrir PR e validar checks.

Ambos devem:

- trabalhar em branch isolada;
- partir da `main` atualizada;
- não mudar contratos fora do escopo;
- não alterar Meta/Coexistência sem necessidade explícita;
- não fazer merge com checks vermelhos;
- parar em incompatibilidade real;
- não usar produção para experimentos.

---

# Resultado esperado

A Lívia evolui sem perder o serviço atual:

```text
Atendimento confiável
+
Cobrança
+
IA mais capaz
+
CRM central
+
Equipes
+
Marketing
+
Vendas
+
Pagamentos
```

O produto deve crescer sobre a V1, não substituí-la.
