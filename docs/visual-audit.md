# Auditoria Visual — Lívia (Fase 0)

> **Escopo:** 100% frontend/visual. Zero alteração de lógica, APIs, Firebase, Meta/WhatsApp, OpenAI/IA, prompts, contratos, handlers ou hooks de dados.
> **Status desta fase:** somente leitura. Nenhum arquivo de código foi tocado. Este documento é o único entregável da Fase 0.
> **Método:** leitura estática completa de todas as rotas, componentes de layout, design system (`components/ui/*`) e tokens (`tailwind.config.ts`, `app/globals.css`). A verificação de `next build` / `tsc --noEmit` / testes (274) roda no início da Fase 1 (exige env do Firebase).
> **Data:** Fase 0 — pré-refino.

---

## 0. Sumário executivo

O app já tem um design system inicial coerente (PR #1): paleta roxa (`#7c3aed`), família `ink` para neutros, tokens semânticos, componentes `Button/Card/Field/StatusBadge/States`. A base é boa. Os problemas são de **consolidação e consistência**, não de reconstrução.

Principais alavancas de percepção, em ordem:

1. **`/login`** — sem marca/identidade visual, mensagens de erro cruas, fundo chapado. Primeira impressão fraca.
2. **`/painel/conversas`** — layout 2 colunas (o plano pede inbox 3 colunas), sem avatares, altura fixa inline, chips de filtro em padrão próprio, timestamps minúsculos. Maior alavanca de uso diário.
3. **Inconsistência transversal de "chips/pills selecionáveis"** — há **5+ implementações diferentes** do mesmo padrão (filtros de conversas, chips de conhecimento, abas de configurações, slots de agenda, tab bar). Candidato a 1–2 componentes.
4. **Modais improvisados** (`ConfirmDialog`, `TeachDialog`) — sem foco preso, sem ESC, sem `role=dialog`, markup duplicado. A11y fraca → candidato a Radix Dialog.
5. **Escala tipográfica e de foco inconsistentes** — H1 varia (`text-2xl` vs `text-xl`), `PageHeader` usado em algumas páginas e improvisado em outras; anel de foco com opacidades diferentes e ausente em vários elementos nativos.
6. **Responsividade** — `MobileTabBar` com **7 itens** em 375px, aba "Agenda" em `/configuracoes` com muitos `input[type=time]` quebrando no mobile, alturas `70vh` inline.

Nenhum achado exige tocar lógica. Todos são resolvíveis via JSX/classes/tokens.

---

## 1. Fundação — tokens e tipografia (`tailwind.config.ts`, `app/globals.css`)

### 1.1 Paleta
- **Neutros incompletos.** Existe só `ink` 900/700/500/400. Faltam degraus intermediários (600/800) e claros (50–300) e escuros (950). O plano pede escala neutra 50–950. Hoje isso força o uso de opacidades de `line` como "cinzas", gerando o problema abaixo.
- **Superfícies via opacidade arbitrária.** Espalhados pelo app: `bg-line/10`, `/20`, `/30`, `/40`, `/50`, `/60` e `success-bg/30`, `warning-bg/20`, `danger-bg/20`, `/40`, `primary-light/30`, `/40`, `/50`. Não há token de superfície (ex.: `surface`, `muted`, `subtle`). Resultado: fundos de cartões/hover/seleção quase iguais mas nunca idênticos.
- **Cor fora de token.** `AppShell` usa `amber-50/amber-200/amber-900` (Tailwind default) no banner "Atendimento pausado", em vez dos tokens `warning`. `app/page.tsx` (rota `/`) usa `style` inline com hex `#555` e tamanhos de fonte crus — totalmente fora do design system.

### 1.2 Sombras / elevação
- Só `shadow-card` e `shadow-popover`. O plano pede elevação 0–3. Não há degrau para hover de cartão, dropdown, dialog vs. popover.

### 1.3 Tipografia
- **Sem tokens de tipografia** (display/heading/body/label/caption com line-height e peso definidos). Tudo é ad-hoc.
- **Hierarquia de H1 inconsistente:** `PageHeader` e `/login` e `/painel` usam `text-2xl font-bold`; `/painel/onboarding` usa `text-xl font-bold`; `CardTitle` `text-lg font-semibold`; `GuidedSection` título `text-base font-semibold`; `StepHeader` `text-lg font-bold`. Não há uma escala única.
- **`PageHeader` não é usado uniformemente.** `agenda`, `conversas`, `whatsapp`, `configuracoes`, `conhecimento`, `clientes` usam `PageHeader`; `/painel` (overview) monta o cabeçalho manualmente (saudação "Olá 👋" + `<h1>` + `<p>`).
- **Textos minúsculos** `text-[10px]` (timestamps de mensagens, labels da tab bar) e `text-[11px]` (categoria de inbox, "Corrigir") — abaixo do confortável e frágeis para contraste AA.

### 1.4 Estados globais (foco/hover/disabled)
- **Anel de foco divergente:** `Button` usa `focus-visible:ring-2 ring-primary/40`; `Field` (Input/Textarea/Select) usa `focus:ring-2 ring-primary/20` (opacidade diferente **e** `focus` em vez de `focus-visible`).
- **Foco ausente** em muitos elementos interativos nativos (`<button>`/`<a>` fora do componente `Button`): filtros de conversas, chips de conhecimento, abas de configurações, slots de horário da agenda, setas ‹ › de dia, links da sidebar/tab bar, "Esqueci minha senha", "Corrigir", "hoje", "Ver conversa completa". A11y de teclado prejudicada.
- **Disabled** só via `opacity-50` no `Button`; inputs desabilitados usam `bg-line/20` — sem padrão único.

---

## 2. Componentes base (`components/ui/*`)

| Componente | Achado | Severidade |
|---|---|---|
| `Button` | Só tamanhos `sm/md` (o plano pede `sm/md/lg`). **Sem estado `loading`** — hoje cada página faz `{busy ? "Salvando…" : "Salvar"}` manualmente + `disabled`. Variante `ghost` é borda **tracejada** roxa (parece placeholder) usada em "Adicionar"/"Usar exemplo". | Média |
| `Field` (Input/Textarea/Select/Label/FieldHelp) | **Não há estado de erro visual** nem componente `Field` que junte label+hint+erro. Erros são `<p className="text-danger-fg">` soltos, repetidos em login/config/conhecimento/onboarding. Sem `aria-invalid`. | Média |
| `StatusBadge` | Bom e reutilizado. Mas **não existe `Badge` genérico** → "pílulas" ad-hoc para intenções (`bg-line/40`), correções (`bg-primary-light`), "recomendado" (`bg-success-bg`), contadores. | Média |
| `Card` / `CardTitle` | OK. Padding `p-5 sm:p-6` consistente. Sem variação de elevação no hover (cards clicáveis do overview não têm affordance). | Baixa |
| `Toggle` | Bom, acessível via `peer`. Sem foco visível no track. | Baixa |
| `States` (Loading/Empty/Error) | Bons e usados. Porém **Loading é sempre spinner** (`Loader2`); o plano (Fase 5) pede skeletons onde já há loading. `EmptyState` existe mas nem sempre é usado (ver §3). | Média |
| `PageHeader` | Bom, mas não é usado em todas as páginas (ver §1.3). | Baixa |
| `ConfirmDialog` | **Modal improvisado:** sem `role="dialog"`/`aria-modal`, sem foco preso, sem fechar no ESC, sem travar scroll do body, backdrop não fecha ao clicar. | Alta (a11y) |
| **Ausentes** | Não existem: `Badge`, `Tabs`/`SegmentedControl`, `Table`, `Skeleton`, `Dropdown/Menu`, componente de `Toast`/feedback inline. | Alta |

> **Radix pontual sugerido:** `@radix-ui/react-dialog` para unificar `ConfirmDialog` + `TeachDialog` (hoje duplicados) resolvendo a11y de uma vez, mantendo props públicas idênticas. (A confirmar com você.)

---

## 3. Achados por página (ordem de prioridade do plano)

### 3.1 `/login` — primeira impressão (alto impacto)
- Sem logo/marca visual; só o texto "Entrar na Livia". Fundo `bg-line/20` chapado, sem identidade.
- `max-w-[380px]` arbitrário (fora de token de largura).
- Mensagens de erro/sucesso são `<p>` cruas no fim do card (sem ícone/container, inconsistentes com `ErrorState`).
- "Esqueci minha senha" é um `<button>` sem foco, posicionado **acima** do botão "Entrar" (ordem incomum).
- Botão "Entrar" já tem loading textual (`Entrando…`) — bom, mas via string manual (ver §2 `Button.loading`).

### 3.2 `/painel` (overview) — segunda tela vista
- **4 cards de status** com markup repetido (ícone em pílula colorida + label + valor + link) sem um componente `StatCard` → duplicação e risco de divergência.
- Card "Agendamento pela IA" usa ícone neutro `bg-line/60` enquanto os outros usam cor semântica — leve quebra de padrão.
- Métricas com `text-lg font-bold`/`text-xl` sem hierarquia definida (número de destaque deveria ter escala própria).
- Dois grids `sm:grid-cols-2` separados com `mt-4` em vez de um grid único → ritmo vertical desigual em telas médias.
- Cabeçalho montado à mão (não usa `PageHeader`); emoji na saudação.
- `FunnelStep`, chips de "intenções frequentes" e cards de métrica — mais padrões de "pílula/cartão pequeno" sem unificação.

### 3.3 `/painel/conversas` — **maior alavanca**
- **Layout 2 colunas** (lista + thread). O plano pede **inbox 3 colunas** (lista / thread / detalhes) — falta o painel de contexto do cliente à direita.
- **Altura fixa `style={{ height: "70vh" }}`** inline (também em `/clientes`) — não responsiva; pode cortar em telas baixas e desperdiçar espaço em telas altas.
- **Sem avatares** na lista (o plano pede "avatares consistentes"); item é só nome + badge + data.
- Sem indicação visual de "não lida"/prioridade além do badge.
- Chips de filtro (`Todas / Precisa de atenção / …`) em **padrão próprio** (`border bg-primary text-white` quando ativo) — diverge das abas de config e dos chips de conhecimento.
- **Bolhas de mensagem:** cliente `bg-line/40`, atendente `bg-info` (azul), bot `bg-primary` (roxo). Timestamps `text-[10px]` e rótulo "· Livia/· atendente" muito pequenos; sem avatar/inicial. Raio `rounded-card` uniforme (visual genérico).
- Botão "Corrigir": `text-[11px] text-ink-400` — baixo contraste e alvo de toque pequeno.
- **Estado vazio da direita** é `<p>Selecione uma conversa…</p>` cru — deveria usar `EmptyState` com ilustração.

### 3.4 `/painel/agenda`
- Lista simples (o plano cita "timeline/lista"); sem trilha de horário.
- **Hierarquia de ações fraca:** Confirmar/Concluir/Faltou são todos `secondary` + Cancelar `danger` — mesmo peso visual; o plano pede "ações principais vs secundárias".
- Navegação de dia só com ‹ › + "hoje" (sem date picker).
- `NewAppointment`: form inline com inputs `basis-[200px]/160px/150px` que quebram em larguras intermediárias; **campos sem `<label>`** (só placeholder) → a11y fraca. Card em `bg-primary-light/40`.
- Slots de horário = mais um padrão de "pílula selecionável".

### 3.5 `/painel/whatsapp`
- Os **8 estados** do `WhatsAppConnectionCard` estão bem construídos e serão preservados. Refino: padronizar opacidades de fundo entre estados (`success-bg/30`, `warning-bg/20`, `warning-bg/30`, `danger-bg/20` variam) e consistência dos círculos de ícone.
- O badge de status do WhatsApp no `Header` é uma pílula colorida **cheia**; o plano pede algo "mais discreto e informativo".
- `DevPhaseSwitcher` só em dev — OK, não afeta produção.

### 3.6 `/painel/configuracoes`
- Abas (Empresa/Atendente/Agenda) reimplementadas como segmented control (`bg-line/40 p-1`) — candidato ao componente `Tabs`.
- **Aba "Agenda" é o pior ponto de responsividade:** cada dia tem checkbox + 2 `input[type=time]` (abre/fecha) + textos "pausa/-" + 2 `input[type=time]` (pausa) num `flex-wrap` → em 375px vira uma pilha confusa e densa.
- Feedback "Salvo!/Erro ao salvar" como texto solto (repete em conhecimento e onboarding).
- Sem agrupamento visual dentro das abas (um `Card` único por aba).

### 3.7 `/painel/conhecimento`
- Formulário **muito longo** (7 seções guiadas + FAQ + correções). Respiro por `GuidedSection` é bom, mas o botão **Salvar fica só no fim** (precisa rolar tudo) — candidato a barra de ação fixa/sticky.
- **Dois cartões de "modelo"** (primeira visita vs. recorrente) com estilos diferentes.
- Chips de template = mais um padrão de pílula selecionável.
- Botões `ghost` tracejados ("Usar exemplo", "Adicionar serviço/pergunta") reforçam a aparência de placeholder.

### 3.8 `/painel/onboarding`
- Stepper é uma barra de progresso segmentada (`h-1.5`), mas **os rótulos das etapas (`STEP_LABELS`) não são exibidos** — o array só serve para contar. O plano pede "stepper visual" (números/rótulos).
- **Sem transições** entre etapas (o plano, Fase 5, pede transições sutis 150–200ms).
- Passo 3 (WhatsApp) usa o card como demonstração com timeout falso — comportamento visual, mantido.

### 3.9 `/painel/clientes`
- Reaproveita o layout 2 colunas de conversas (bom para coerência) → herda os mesmos problemas: `70vh` inline, sem avatares.
- Painel de detalhe (linhas ícone/label/valor) é limpo e OK.

### 3.10 `/` (`app/page.tsx`)
- Landing pública com **`style` inline e hex cru** (`#555`), fora completamente do design system. (Verificar com você se está no escopo — é a inconsistência mais gritante de "cor/tipografia fora de token".)

---

## 4. Navegação & Shell (`components/layout/*`)

- **`Sidebar`:** estado ativo (`bg-primary-light text-primary`) OK. **Sem agrupamento** de itens (o plano pede agrupar). **Sem avatar/usuário no rodapé** (o plano pede) — o logout vive no `Header`. Logo é só texto "Livia".
- **`Header`:** título derivado de `NAV_ITEMS`; badge do WhatsApp é pílula colorida cheia (pouco discreta); `LogoutButton` é um botão com borda solto.
- **`MobileTabBar`:** **`NAV_ITEMS` tem 7 itens** e todos aparecem na tab bar mobile com ícone + label `text-[10px]` → em 375px fica muito apertado/arriscado a overflow (o próprio comentário do código assume "5 itens já não cabem confortável"). Precisa de estratégia (priorizar 4–5 + "Mais", ou reduzir).
- **Banner "Atendimento pausado"** no `AppShell` usa `amber-*` fora de token (ver §1.1).

---

## 5. Microinterações & polimento (base para Fase 5)

- **Transições** só existem como `transition-colors` em botões/links; faltam durações padronizadas (150–200ms ease-out) em hover/foco/abertura de menu e nas trocas de etapa do onboarding.
- **Loading = spinner** em todo lugar (`LoadingState`); nenhum skeleton, apesar de haver layouts previsíveis (listas de conversas/clientes/agenda, cards do overview) — bons candidatos.
- **Estados vazios inconsistentes:** `EmptyState` em agenda/conversas-lista/clientes-lista; mas `<p>` cru na coluna direita de conversas e no "Nenhum agendamento para hoje" do overview.
- **Feedback de sucesso/erro** ("Salvo!", "Erro ao salvar", "Correção salva") é texto solto duplicado em 3+ telas — sem componente único (toast inline/badge).

---

## 6. Responsividade (1440 / 1280 / 768 / 375)

| Ponto | Problema |
|---|---|
| `MobileTabBar` @375 | 7 itens apertados; risco de truncamento e alvo de toque < 44px. |
| `/configuracoes` aba Agenda @375/768 | Linha de horários com 4 `input[type=time]` + textos quebra em pilha confusa. |
| `/conversas` e `/clientes` | `height: 70vh` inline não se adapta a telas baixas (corte) nem altas (desperdício). |
| `/agenda` `NewAppointment` | Inputs com `basis-[…]` quebram desalinhados em larguras intermediárias (~600–800px). |
| Bolhas/pílulas | vários `text-[10px]/[11px]` ficam sub-legíveis no mobile. |

---

## 7. Acessibilidade visual (WCAG AA)

- **Contraste:** `text-ink-400` (#98a2b3) sobre branco ≈ 2.5:1 — **abaixo de AA** para texto pequeno; usado em muitos metadados (datas, hints, "Corrigir", labels da tab bar inativa `text-ink-400`). `text-white/70` em bolhas idem.
- **Foco visível:** ausente na maioria dos controles nativos (ver §1.4). Bloqueador de AA para navegação por teclado.
- **Alvos de toque:** chips/botões pequenos (`px-2/3 py-1/1.5`, `text-[10px]`) < 44px no mobile.
- **Modais:** sem `role`/foco preso/ESC (ver §2).
- **Inputs sem label** em `NewAppointment` (agenda) e placeholders usados como rótulo.
- **Ícones decorativos** em `StatusBadge`/cabeçalhos sem `aria-hidden` em alguns casos.

---

## 8. Inconsistências transversais (resumo priorizado)

1. **5+ padrões de "chip/pílula/aba selecionável"** → unificar em `Tabs`/`SegmentedControl` + `Chip`. *(alto impacto de consistência)*
2. **Superfícies via opacidades arbitrárias** de `line`/semânticas → criar tokens de superfície e escala neutra 50–950. *(fundação)*
3. **Modais duplicados sem a11y** → unificar (Radix Dialog sugerido). *(a11y)*
4. **Tipografia/H1 e uso de `PageHeader` inconsistentes** → escala tipográfica + aplicar `PageHeader` em todas as páginas. *(fundação)*
5. **Anel de foco divergente/ausente** → um token de focus-ring aplicado a todos os interativos. *(a11y)*
6. **Feedback de status como texto solto** → componente único. 
7. **Loading sempre spinner** → skeletons. 
8. **Cores fora de token** (`amber-*`, hex inline). 
9. **Alturas/larguras mágicas inline** (`70vh`, `max-w-[380px]`, `basis-[200px]`). 
10. **Sem `StatCard`/`Badge`** → duplicação no overview e pílulas ad-hoc.

---

## 9. Mapa Achados → PRs propostos

- **PR-B (Fase 1 · tokens/tipografia):** §1 inteiro — escala neutra 50–950, tokens de superfície, elevação 0–3, escala tipográfica, focus-ring único, remover `amber-*` e hex inline.
- **PR-C (Fase 2 · componentes):** §2 — `Button` (add `lg` + `loading` opcional), estado de erro em `Field`, `Badge`, `Tabs/SegmentedControl`, `Skeleton`, unificar modais (Radix), `StatCard`.
- **PR-D `/login`:** §3.1.
- **PR-E `/painel`:** §3.2.
- **PR-F `/painel/conversas`:** §3.3 (3 colunas, avatares, altura fluida, EmptyState).
- **PR-G `/painel/agenda`:** §3.4.
- **PR-H `/painel/whatsapp`:** §3.5.
- **PR-I `/painel/configuracoes`:** §3.6 (Tabs + aba Agenda responsiva).
- **PR-J `/painel/conhecimento`:** §3.7 (+ `/onboarding` §3.8 e `/clientes` §3.9 conforme prioridade).
- **PR-K (Fase 4 · shell):** §4.
- **PR-L (Fase 5–6 · microinterações + QA):** §5, §6, §7.

---

## 10. Confirmação de não-invasão (Fase 0)

- [x] Nenhum arquivo em `app/api/**` lido para alteração (apenas contratos observados via `fetch` no client).
- [x] Nenhum arquivo em `lib/{ai,auth,whatsapp,scheduling,repo}/**`, `types/**`, `firebase*`, `.env*`, `next.config.js`, `vercel.json` foi tocado.
- [x] Único arquivo criado nesta fase: **este** (`docs/visual-audit.md`).
- [ ] `next build` / `tsc --noEmit` / testes (274) — a validar no início da Fase 1 (requer env do Firebase).
