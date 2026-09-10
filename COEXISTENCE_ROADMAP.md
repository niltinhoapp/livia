# Lívia — Roteiro Completo de Coexistência WhatsApp

> Documento de continuidade técnica. Este arquivo **não substitui** o `README.md`. Ele complementa as regras de produção, estabilização e receita já definidas no projeto e registra o roteiro completo para adicionar o modo Coexistência sem perder o que já funciona.

---

# 1. Regra principal do projeto

A Lívia já possui um núcleo funcional e não deve ser reescrita para adicionar Coexistência.

A estratégia oficial é:

```text
Núcleo atual funcionando
        ↓
Adicionar suporte a Coexistência
        ↓
Preservar Cloud API existente
        ↓
Testar regressão
        ↓
Validar Coexistência isoladamente
        ↓
Ativar Coexistência somente quando o código estiver pronto
```

**Não quebrar o fluxo Cloud API atual para criar o fluxo Coexistência.**

A implementação deve ser incremental, reversível e protegida por testes.

---

# 2. O que já existe e deve ser preservado

O `README.md` continua sendo a fonte principal das regras gerais de produção, estabilização e receita.

A Lívia já possui, entre outros:

- WhatsApp oficial via Meta Cloud API;
- Embedded Signup;
- recebimento e envio de mensagens;
- IA para atendimento;
- base de conhecimento;
- agenda;
- criação, consulta, remarcação e cancelamento de agendamentos;
- memória estruturada do cliente;
- resumo de conversa;
- detecção de intenção;
- estado de tarefa;
- ferramentas internas;
- política para não inventar informações operacionais;
- handoff humano;
- fila de pendências;
- recurso para ensinar/corrigir a Lívia;
- CRM automático;
- caixa de entrada inteligente;
- oportunidades;
- funil;
- dashboard diário;
- autenticação;
- multi-tenant;
- persistência no Firestore.

Nada disso deve ser removido ou refeito apenas por causa da Coexistência.

---

# 3. Estado atual antes da implementação

## Integração atual

O projeto usa Meta Graph API `v24.0` e possui fluxo de Embedded Signup com:

```text
FB.login
   ↓
code
   ↓
exchangeCodeForToken
   ↓
validar WABA
   ↓
validar phone_number_id
   ↓
subscribe app to WABA
   ↓
register phone number
   ↓
connected
```

O fluxo atual foi construído para Cloud API tradicional e utiliza PIN persistido/encriptado para o registro do número.

## Persistência atual

`EstablishmentWhatsapp` mantém:

- `wabaId`;
- `phoneNumberId`;
- `status`;
- token criptografado;
- PIN criptografado;
- PINs por número;
- timestamps;
- lease/attempt para impedir concorrência;
- `registeredAt`.

O campo `registeredAt` representa o registro efetivo do número pela Lívia.

## Webhook atual

O webhook já:

- valida assinatura HMAC;
- recebe mensagens e status;
- resolve o estabelecimento pelo `phone_number_id`;
- faz deduplicação;
- grava a mensagem do cliente;
- executa regras de handoff;
- chama a IA;
- envia resposta pela Cloud API;
- grava a resposta enviada.

Esse fluxo deve continuar intacto para mensagens normais da Cloud API.

---

# 4. Objetivo da Coexistência

Adicionar suporte para que um mesmo número possa funcionar com:

```text
WhatsApp Business App
        +
WhatsApp Cloud API
        +
Lívia
```

A Lívia continuará usando o mesmo número e a mesma infraestrutura de envio pela Cloud API.

Não criar um segundo sistema de envio.

Não criar uma segunda conversa por contato.

Não duplicar o CRM.

Não duplicar a agenda.

Não criar uma segunda IA.

---

# 5. Modelo de dados alvo

Adicionar ao `EstablishmentWhatsapp`:

```ts
connectionMode: "cloud_api" | "coexistence"
```

Modelo conceitual:

```text
EstablishmentWhatsapp
├── connectionMode
│   ├── cloud_api
│   └── coexistence
├── wabaId
├── phoneNumberId
├── accessToken
├── status
├── lease data
├── timestamps
└── dados legados preservados
```

## Regra de compatibilidade

Registros existentes devem continuar funcionando mesmo durante a migração do código.

Quando `connectionMode` não existir em um registro antigo, o comportamento deve ser compatível com o modo atual Cloud API, evitando quebra de dados existentes.

Não apagar PINs ou campos legados sem necessidade.

---

# 6. Dois fluxos de conexão

## 6.1 Cloud API — manter

```text
Embedded Signup
    ↓
OAuth code
    ↓
Troca por token
    ↓
Validação de ownership
    ↓
Subscribe WABA
    ↓
Register phone number
    ↓
connected
```

Esse caminho deve continuar funcionando como hoje.

## 6.2 Coexistência — novo

```text
Embedded Signup
    ↓
featureType de Coexistência
    ↓
OAuth code
    ↓
Troca por token
    ↓
Validação de ownership
    ↓
Subscribe WABA
    ↓
Concluir onboarding Coexistência
    ↓
connected
```

O `/register` não deve ser tratado como etapa obrigatória do fluxo Coexistência.

O código deve separar explicitamente as duas modalidades.

---

# 7. Embedded Signup

Arquivo principal:

```text
components/whatsapp/useEmbeddedSignup.ts
```

Hoje o fluxo utiliza `FB.login` com:

```ts
extras: {
  setup: {},
  sessionInfoVersion: "3"
}
```

Para Coexistência será necessário suportar o onboarding específico, incluindo o `featureType` correspondente ao WhatsApp Business App onboarding.

O fluxo existente não deve ser removido.

Arquitetura desejada:

```text
startEmbeddedSignup(mode)
          ↓
   ┌──────┴──────┐
   ↓             ↓
cloud_api   coexistence
```

O resultado deve carregar explicitamente o modo escolhido, em vez de depender de inferência posterior.

---

# 8. Mensagens do Embedded Signup

Arquivo:

```text
components/whatsapp/embeddedSignupMessage.ts
```

O parser atual já restringe as origens a:

- `https://www.facebook.com`;
- `https://web.facebook.com`.

Isso deve continuar.

O parser deve ser ampliado somente para reconhecer os eventos necessários ao onboarding Coexistência.

Regras:

- manter validação de origem;
- manter isolamento por tentativa;
- manter tratamento de `CANCEL`;
- manter tratamento de `FINISH`;
- não aceitar dados arbitrários como OAuth code;
- manter o OAuth code vindo do fluxo oficial do `FB.login`;
- adicionar somente os eventos comprovadamente necessários para Coexistência.

---

# 9. API de conexão

Arquivo:

```text
app/api/whatsapp/connect/route.ts
```

Hoje recebe:

```ts
{
  code,
  wabaId,
  phoneNumberId
}
```

Deve passar a receber também o modo de conexão, por exemplo:

```ts
connectionMode: "cloud_api" | "coexistence"
```

## Cloud API

Continuar:

1. validar entrada;
2. claim da conexão;
3. trocar code por token;
4. validar ownership;
5. subscribe WABA;
6. obter/preservar PIN;
7. registrar número;
8. finalizar conexão.

## Coexistência

Executar:

1. validar entrada;
2. claim da conexão;
3. trocar code por token;
4. validar ownership;
5. subscribe WABA;
6. executar somente as etapas próprias da Coexistência;
7. não exigir `/register` como pré-condição;
8. finalizar com `connectionMode: "coexistence"`.

Erros e estados devem ser explícitos para que uma falha de Coexistência não seja interpretada como falha de Cloud API.

---

# 10. Persistência e concorrência

Arquivo:

```text
lib/repo.ts
```

A lógica de lease/attempt existente deve ser preservada.

Objetivos:

- impedir duas conexões simultâneas para o mesmo estabelecimento;
- impedir dois estabelecimentos conectarem o mesmo número;
- permitir retomada segura de tentativa expirada;
- preservar dados existentes;
- não gerar PIN desnecessariamente no modo Coexistência;
- não apagar token ou estado útil durante uma tentativa parcial;
- finalizar a conexão de forma atômica sempre que possível.

`claimWhatsappConnection()` e `finalizeWhatsappConnection()` devem ser estendidos, não substituídos por uma implementação paralela.

---

# 11. Envio de mensagens

Arquivo:

```text
lib/whatsapp/client.ts
```

O sender atual deve continuar sendo o único sender.

A Coexistência não exige um novo cliente de envio.

A arquitetura continua:

```text
Lívia
  ↓
sendText / sendTemplate
  ↓
phoneNumberId
  ↓
Meta Cloud API
```

Se necessário, adicionar metadados internos para identificar a origem da mensagem enviada pela Lívia.

Não alterar o contrato de envio sem necessidade.

---

# 12. Webhook — principal ponto de atenção

Arquivo:

```text
app/api/webhooks/whatsapp/route.ts
```

A Coexistência adiciona eventos que não podem entrar cegamente no pipeline normal de IA.

Arquitetura alvo:

```text
Meta webhook
      ↓
identificar tipo
      ↓
 ┌────┼───────────────┐
 ↓    ↓               ↓
msg  status     coexistence events
 ↓    ↓               ↓
AI   status      tratamento próprio
```

Eventos relevantes da Coexistência podem incluir:

- `smb_message_echoes`;
- `history`;
- `smb_app_state_sync`.

Os nomes e formatos exatos devem ser tratados conforme a documentação Meta vigente no momento da implementação.

---

# 13. Regra crítica para `smb_message_echoes`

Mensagem enviada pelo humano no WhatsApp Business App pode aparecer no sistema como echo.

Esse echo **não é uma nova mensagem do cliente para a IA**.

Portanto:

```text
WhatsApp Business App
       ↓
human message
       ↓
Meta echo
       ↓
Lívia recebe
       ↓
gravar no histórico
       ↓
NÃO chamar IA
       ↓
NÃO responder automaticamente
```

Esse é um requisito de segurança funcional.

Se o echo for enviado para `processMessage()` como se fosse mensagem do cliente, existe risco de:

- IA responder uma mensagem humana;
- loop de atendimento;
- duplicação de mensagens;
- histórico incorreto;
- conflito entre humano e IA.

---

# 14. Histórico de conversa

A conversa deve continuar sendo única por estabelecimento/contato.

Não criar:

```text
conversa-app
conversa-api
```

Criar:

```text
uma conversa
   ├── cliente
   ├── Lívia
   └── humano
```

Para isso, a mensagem precisa carregar origem suficiente para o sistema saber quem produziu o conteúdo.

Modelo conceitual:

```text
message
├── role
├── text
├── at
├── waMessageId
└── source/origin
```

A nomenclatura final deve respeitar os tipos existentes no projeto.

Possíveis origens:

```text
customer
bot
human
```

O importante é o comportamento, não o nome do campo.

---

# 15. Regra de disparo da IA

A IA só deve ser acionada quando a mensagem for realmente uma entrada que exige atendimento automático.

```text
customer message
   ↓
IA pode processar
```

Enquanto:

```text
human/App message
   ↓
salvar histórico
   ↓
NÃO processar IA
```

E:

```text
Lívia/API message
   ↓
registrar/confirmar origem
   ↓
NÃO tratar como nova mensagem do cliente
```

Essa regra deve existir no backend, não apenas no prompt.

---

# 16. Histórico inicial e sincronização

Quando a Coexistência fornecer histórico do WhatsApp Business App, o sistema deve:

1. identificar estabelecimento;
2. identificar contato;
3. localizar conversa existente;
4. deduplicar por identificador confiável quando disponível;
5. inserir somente mensagens ausentes;
6. preservar ordem temporal;
7. marcar origem corretamente;
8. nunca disparar IA durante sincronização histórica.

A sincronização deve ser idempotente.

Executar duas vezes não pode duplicar a conversa ou mensagens.

---

# 17. Estado do WhatsApp Business App

Eventos de estado do aplicativo devem ser tratados separadamente do fluxo de mensagens.

Exemplo conceitual:

```text
smb_app_state_sync
        ↓
atualizar estado interno necessário
        ↓
não criar mensagem artificial
        ↓
não chamar IA
```

Somente dados necessários para o funcionamento da Lívia devem ser persistidos.

---

# 18. Handoff humano

A Coexistência deve melhorar o handoff, não criar um segundo modo de atendimento.

Fluxo desejado:

```text
Cliente
  ↓
Lívia atende
  ↓
necessita humano
  ↓
handoff
  ↓
humano responde pelo WhatsApp Business App
  ↓
echo entra na Lívia
  ↓
histórico atualizado
  ↓
IA NÃO responde
```

Quando o humano devolver o atendimento à Lívia, isso deve ser uma mudança explícita de estado já suportada pelo sistema ou uma extensão mínima do mecanismo atual.

Não inferir que o humano devolveu o atendimento apenas porque uma mensagem chegou.

---

# 19. Desconexão

Arquivo:

```text
app/api/whatsapp/disconnect/route.ts
```

O comportamento atual é:

- best-effort unsubscribe quando aplicável;
- não deregistrar o número;
- preservar PIN;
- limpar token/estado de conexão;
- manter dados históricos.

Para Coexistência, revisar cuidadosamente o unsubscribe para garantir que a desconexão da Lívia não provoque uma ação destrutiva ou inesperada no WhatsApp Business App.

Regra:

> Desconectar a Lívia não deve significar apagar ou inutilizar a conta WhatsApp Business do estabelecimento.

---

# 20. Compatibilidade retroativa

Regra absoluta:

```text
estabelecimento antigo
       ↓
connectionMode ausente
       ↓
assumir Cloud API legado
```

Nenhum estabelecimento existente deve ficar desconectado apenas porque o novo campo ainda não existia.

Migração de dados deve ser evitada se um default seguro no código for suficiente.

---

# 21. Interface do painel

Arquivo principal:

```text
app/painel/whatsapp/page.tsx
```

A UI deve permitir escolher claramente:

```text
Cloud API
Coexistência
```

Sem alterar o fluxo atual de forma confusa.

A Coexistência deve explicar de forma objetiva que o número poderá continuar sendo usado pelo WhatsApp Business App enquanto a Lívia atende via Cloud API.

Não inserir textos promocionais ou promessas técnicas não comprovadas.

---

# 22. Segurança

Nunca:

- expor access token;
- expor app secret;
- expor PIN;
- colocar token em logs;
- confiar em `postMessage` sem validar origem;
- aceitar `wabaId`/`phoneNumberId` sem validação de ownership;
- permitir conexão cruzada entre tenants;
- permitir que echo de outro número entre em uma conversa errada.

Manter:

- criptografia dos segredos;
- HMAC do webhook;
- validação de tenant;
- validação de ownership;
- leases;
- deduplicação.

---

# 23. Testes obrigatórios

A implementação só deve ser considerada pronta quando houver testes para os dois modos.

## Conexão

- Cloud API continua conectando;
- Coexistência conecta;
- Coexistência não exige register indevido;
- ownership inválido falha;
- tenant inválido falha;
- tentativa duplicada falha com segurança;
- lease continua funcionando;
- desconexão continua funcionando.

## Webhook

- mensagem normal do cliente chama IA;
- status não chama IA;
- echo humano não chama IA;
- echo é persistido corretamente;
- histórico não chama IA;
- state sync não chama IA;
- mensagem duplicada não gera segunda ação;
- mensagem de outro phone number não entra no estabelecimento errado.

## Histórico

- mesma mensagem não é duplicada;
- histórico é idempotente;
- ordem temporal é preservada;
- origem é preservada;
- conversa permanece única por contato.

## Regressão

Todos os testes atuais devem continuar passando.

---

# 24. Matriz mínima de comportamento

| Evento | Persistir | IA | Responder |
|---|---|---|---|
| Cliente envia mensagem | Sim | Sim, se aplicável | Sim, se aplicável |
| Meta status | Conforme necessário | Não | Não |
| Humano envia pelo App / echo | Sim | **Não** | **Não** |
| Histórico Coexistência | Sim | **Não** | **Não** |
| Estado do App | Conforme necessário | **Não** | **Não** |
| Mensagem enviada pela Lívia | Sim/confirmar | **Não** | Já enviada |

---

# 25. Ordem oficial de implementação

Não executar tudo de uma vez.

## Fase 0 — documentação e baseline

- manter `README.md` intacto;
- manter este roteiro versionado;
- confirmar branch/deploy atual;
- rodar testes atuais;
- registrar baseline de build/typecheck/test.

## Fase 1 — modelo de dados

- adicionar `connectionMode` de forma retrocompatível;
- ajustar tipos;
- ajustar persistência;
- não alterar ainda a UI Meta.

## Fase 2 — conexão backend

- separar Cloud API de Coexistência;
- preservar `/register` apenas para Cloud API;
- implementar finalização Coexistência;
- criar testes.

## Fase 3 — Embedded Signup

- adicionar modo Coexistência;
- adicionar configuração específica;
- preservar fluxo atual;
- ampliar parser de eventos com segurança;
- criar testes.

## Fase 4 — webhook

- classificar eventos antes do `processMessage()`;
- implementar echo;
- implementar histórico;
- implementar app state;
- impedir IA para eventos de Coexistência que não sejam mensagens de cliente;
- criar testes de regressão.

## Fase 5 — histórico e handoff

- adicionar origem das mensagens;
- manter conversa única;
- tornar sincronização idempotente;
- validar comportamento humano → Lívia.

## Fase 6 — painel

- permitir seleção de modo;
- mostrar estado correto;
- não expor detalhes técnicos desnecessários;
- manter desconexão segura.

## Fase 7 — testes completos

Executar:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Depois testar os dois caminhos em ambiente seguro.

## Fase 8 — validação real

Somente depois dos testes:

```text
número de teste
    ↓
Embedded Signup Coexistência
    ↓
WhatsApp Business App
    ↓
cliente envia mensagem
    ↓
Lívia responde
    ↓
humano envia pelo App
    ↓
Lívia registra
    ↓
Lívia NÃO responde ao humano
```

## Fase 9 — produção

Somente após validação:

- revisar variáveis;
- revisar configuração Meta;
- confirmar webhook;
- confirmar permissões;
- ativar Coexistência no número destinado a isso;
- monitorar logs;
- acompanhar primeiros usuários.

---

# 26. Proteção da revisão Meta

Enquanto a revisão estiver em andamento:

- não alterar permissões sem necessidade;
- não trocar o fluxo já submetido sem necessidade;
- não modificar WABA usada na revisão;
- não substituir o Embedded Signup atual;
- não ativar Coexistência no número de revisão antes da hora;
- priorizar implementação interna e testes.

A Coexistência deve ser adicionada de maneira compatível com o fluxo existente.

Quando for necessário alterar configuração Meta, fazer isso somente depois do código estar pronto e testado.

---

# 27. Número destinado à Coexistência

O número escolhido para Coexistência atualmente **não está em uma conta WhatsApp ativa**.

Portanto:

```text
Agora
↓
auditoria + implementação + testes

Depois
↓
configuração/ativação Meta

Depois
↓
onboarding real do número
```

Não tratar o número como já conectado em Coexistência.

---

# 28. O que NÃO fazer

Não:

- reescrever o webhook inteiro;
- criar segundo sistema de mensagens;
- criar segundo banco de conversas;
- criar segunda IA;
- remover Cloud API;
- tornar `/register` obrigatório para todos os modos;
- resolver echo apenas com prompt;
- confiar somente no `role` para identificar origem;
- disparar IA para qualquer evento recebido pelo webhook;
- fazer migração destrutiva de dados;
- alterar Meta em produção antes dos testes;
- misturar implementação com redesign visual;
- adicionar funcionalidades fora do escopo.

---

# 29. Critério de conclusão

Coexistência só estará pronta quando:

```text
Cloud API atual continua funcionando
                +
Coexistência conecta corretamente
                +
WhatsApp Business App continua utilizável
                +
Cliente recebe atendimento da Lívia
                +
Humano pode responder pelo App
                +
Echo humano entra no histórico
                +
Echo humano NÃO dispara IA
                +
Histórico não duplica
                +
Agenda/CRM continuam intactos
                +
Multi-tenant continua isolado
                +
Testes passam
                +
Build passa
```

---

# 30. Checklist de cada etapa

Antes de avançar de uma fase para outra:

```text
[ ] código atual entendido
[ ] alteração mínima
[ ] Cloud API preservada
[ ] Coexistência isolada
[ ] dados legados preservados
[ ] testes adicionados
[ ] testes atuais passando
[ ] typecheck passando
[ ] lint passando
[ ] build passando
[ ] nenhum segredo exposto
[ ] nenhum bypass de produção criado
[ ] Meta não alterada sem necessidade
```

---

# 31. Registro de decisões

## Decisão 1

**Coexistência será adicionada.**

Não é mais uma hipótese ou experimento de produto. É parte do roteiro técnico da Lívia.

## Decisão 2

**Cloud API permanece.**

Coexistência é uma modalidade adicional de conexão, não substituição.

## Decisão 3

**Uma conversa por contato.**

App e Cloud API alimentam o mesmo histórico.

## Decisão 4

**Humano não aciona IA.**

Mensagens provenientes do WhatsApp Business App devem ser tratadas como comunicação humana e não como nova entrada automática do cliente.

## Decisão 5

**Backend é a fonte da regra crítica.**

Não depender de prompt para evitar loops, duplicações, conflitos ou ações indevidas.

## Decisão 6

**Implementação antes da ativação real.**

Primeiro código, testes e validação. Depois configuração/ativação do número Coexistência.

## Decisão 7

**Sem perda do que já existe.**

Este documento complementa o `README.md`; não substitui as regras de estabilização, produção e receita já estabelecidas.

---

# 32. Próximo passo oficial

A auditoria está encerrada.

O próximo passo de desenvolvimento é **Fase 0 — baseline**, sem alterar o comportamento do produto:

1. confirmar estado da branch/deploy;
2. executar testes atuais;
3. executar typecheck;
4. executar lint/build;
5. registrar o baseline;
6. somente então iniciar a Fase 1.

**Não começar pelo Meta. Não começar pela UI. Não ativar o número. Primeiro garantir uma base limpa e reproduzível.**

---

# Direção final

```text
PRODUTO ATUAL
      ↓
PRESERVAR
      ↓
BASELINE
      ↓
MODELO DE DADOS
      ↓
BACKEND DE CONEXÃO
      ↓
EMBEDDED SIGNUP
      ↓
WEBHOOK + ECHO + HISTORY
      ↓
HISTÓRICO / HANDOFF
      ↓
PAINEL
      ↓
TESTES
      ↓
VALIDAÇÃO REAL
      ↓
ATIVAÇÃO COEXISTÊNCIA
      ↓
PRODUÇÃO
```

A regra é simples: **adicionar Coexistência sem sacrificar o que a Lívia já conquistou.**
