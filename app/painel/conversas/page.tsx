"use client";
// Painel: conversas do WhatsApp — o mínimo necessário pra operação da Livia,
// não uma reconstrução do WhatsApp Web. Lista à esquerda, conversa
// selecionada à direita, status visível, Assumir/Devolver.
//
// Em mobile, lista e conversa não cabem lado a lado: mostra uma coisa de
// cada vez (lista, ou a conversa com um botão "Voltar").
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Bot, UserCheck, AlertCircle, RefreshCw, Trash2, Clock, CalendarClock, Sparkles, MessageCircleWarning, CheckCircle2 } from "lucide-react";
import type { Conversation, InboxCategory } from "@/types";
import { Button } from "@/components/ui/Button";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { PageHeader } from "@/components/ui/PageHeader";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { INBOX_CATEGORY_LABEL, applyOpportunityOverride } from "@/lib/ai/inbox";
import { ConversationDetail, STATUS_LABEL } from "./ConversationDetail";

// Passo 11 — cada conversa vem anotada pelo backend (GET /api/conversations,
// que já reaproveita PendingTask + Opportunity) com sua categoria. Nunca
// recalculada aqui.
type InboxConversation = Conversation & { inboxCategory: InboxCategory };

const INBOX_ICON: Record<InboxCategory, typeof Bot> = {
  needs_human: UserCheck,
  customer_waiting: Clock,
  appointment_incomplete: CalendarClock,
  opportunity: Sparkles,
  complaint: MessageCircleWarning,
  resolved: CheckCircle2,
};

const INBOX_TONE: Record<InboxCategory, StatusTone> = {
  needs_human: "danger",
  customer_waiting: "warning",
  appointment_incomplete: "warning",
  opportunity: "info",
  complaint: "danger",
  resolved: "neutral",
};

type InboxFilter = "all" | "attention" | "opportunity" | "in_service" | "resolved";

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "attention", label: "Precisa de atenção" },
  { id: "opportunity", label: "Oportunidades" },
  { id: "in_service", label: "Em atendimento" },
  { id: "resolved", label: "Concluídas" },
];

// "Em atendimento" e "Concluídas" olham o status bruto/categoria já
// existentes — nenhum critério novo, só uma combinação pra exibição.
function matchesFilter(c: InboxConversation, filter: InboxFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return c.inboxCategory === "needs_human" || c.inboxCategory === "complaint" || c.inboxCategory === "appointment_incomplete";
    case "opportunity":
      return c.inboxCategory === "opportunity";
    case "in_service":
      return c.status === "human";
    case "resolved":
      return c.inboxCategory === "resolved" && c.status !== "human";
  }
}

// "Limpar conversas" só existe para o tenant demo (Odonto) — usado pra
// deixar o painel vazio antes de gravações de demonstração. A trava real é
// no backend (app/api/conversations/clear/route.ts, checa a sessão); isto
// aqui só evita mostrar um botão que sempre falharia pra outro estabelecimento.
const CLEAR_CONVERSATIONS_ESTABLISHMENT_ID = "demo";

const LIST_REFRESH_MS = 15000;
// Oportunidades (Passo 12) saíram do poll de 15s de propósito — ver
// lib/dashboard.ts: classifyConversationsForInbox. GET /api/opportunities
// continua fazendo as mesmas 4 queries de sempre, só que agora só nesta
// cadência bem mais longa, e não mais embutido em toda chamada de
// /api/conversations. 2 minutos é fresco o bastante pro badge (oportunidade
// não é uma condição que aparece e desaparece em segundos) e já é uma queda
// de ~8x nas queries de oportunidade por hora, mesmo sozinho.
const OPPORTUNITIES_REFRESH_MS = 120000;

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<InboxConversation[] | null>(null);
  const [error, setError] = useState(false);
  // conversationId -> tem oportunidade aberta. Buscado à parte, numa cadência
  // bem menor que o poll da lista — ver OPPORTUNITIES_REFRESH_MS.
  const [opportunityIds, setOpportunityIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [canClear, setCanClear] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState(false);

  // Deep-link vindo do CRM (Passo 10: "Ver conversa completa") ou do painel
  // diário (oportunidade) — /painel/conversas?conversa=<id> abre já
  // selecionada, uma vez, sem brigar com a seleção manual do usuário depois.
  const searchParams = useSearchParams();
  const [appliedDeepLink, setAppliedDeepLink] = useState(false);

  const loadList = useCallback(() => {
    fetch("/api/conversations")
      .then((r) => r.json())
      .then((j) => {
        setConversations(j.conversations ?? []);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    loadList();
    const interval = setInterval(loadList, LIST_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadList]);

  useEffect(() => {
    const loadOpportunities = () => {
      fetch("/api/opportunities")
        .then((r) => r.json())
        .then((j) => {
          const ids: { conversationId: string }[] = j.opportunities ?? [];
          setOpportunityIds(new Set(ids.map((o) => o.conversationId)));
        })
        .catch(() => {}); // badge de oportunidade é informativo — falha aqui não pode quebrar a lista
    };
    loadOpportunities();
    const interval = setInterval(loadOpportunities, OPPORTUNITIES_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (appliedDeepLink || !conversations) return;
    const target = searchParams.get("conversa");
    if (target && conversations.some((c) => c.id === target)) {
      setSelectedId(target);
    }
    setAppliedDeepLink(true);
  }, [appliedDeepLink, conversations, searchParams]);

  useEffect(() => {
    fetch("/api/establishment")
      .then((r) => r.json())
      .then((j) => setCanClear(j.establishment?.id === CLEAR_CONVERSATIONS_ESTABLISHMENT_ID))
      .catch(() => setCanClear(false));
  }, []);

  async function handleClearConversations() {
    setClearing(true);
    setClearError(false);
    try {
      const res = await fetch("/api/conversations/clear", { method: "POST" });
      if (!res.ok) throw new Error("falha ao limpar");
      setConfirmClear(false);
      setSelectedId(null);
      loadList();
    } catch {
      setClearError(true);
    } finally {
      setClearing(false);
    }
  }

  if (error) return <ErrorState onRetry={loadList} />;
  if (!conversations) return <LoadingState />;

  // Merge client-side da oportunidade (fetch à parte, cadência mais longa) —
  // a categoria que vem de /api/conversations nunca é "opportunity" mais
  // (ver lib/dashboard.ts), então isso é a única fonte dela agora. Mesma
  // prioridade de sempre: só assume onde o backend já disse "resolved".
  const withOpportunities = conversations.map((c) => ({
    ...c,
    inboxCategory: applyOpportunityOverride(c.inboxCategory, opportunityIds.has(c.id)),
  }));
  const selected = withOpportunities.find((c) => c.id === selectedId) ?? null;
  const filtered = withOpportunities.filter((c) => matchesFilter(c, filter));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Conversas"
        description="Acompanhe o que a Livia está conversando no WhatsApp e assuma quando precisar."
        action={
          <div className="flex items-center gap-2">
            {canClear && (
              <Button variant="danger" size="sm" onClick={() => setConfirmClear(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Limpar conversas
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={loadList}>
              <RefreshCw className="h-3.5 w-3.5" /> Atualizar
            </Button>
          </div>
        }
      />

      {clearError && (
        <p className="mb-4 text-sm font-semibold text-danger-fg">
          Não foi possível limpar as conversas. Tente novamente.
        </p>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="Limpar conversas?"
        description="Tem certeza que deseja limpar todas as conversas deste estabelecimento? Esta ação não poderá ser desfeita."
        confirmLabel={clearing ? "Limpando…" : "Limpar conversas"}
        cancelLabel="Cancelar"
        danger
        confirmDisabled={clearing}
        onConfirm={handleClearConversations}
        onCancel={() => setConfirmClear(false)}
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const count = f.id === "all" ? withOpportunities.length : withOpportunities.filter((c) => matchesFilter(c, f.id)).length;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                filter === f.id ? "border-primary bg-primary text-white" : "border-line text-ink-500 hover:bg-line/20"
              }`}
            >
              {f.label} {count > 0 && <span className="opacity-70">({count})</span>}
            </button>
          );
        })}
      </div>

      <div className="flex overflow-hidden rounded-card border border-line bg-white" style={{ height: "70vh" }}>
        {/* Lista — some no mobile quando uma conversa está aberta */}
        <div className={`w-full shrink-0 overflow-y-auto border-r border-line sm:w-72 ${selectedId ? "hidden sm:block" : "block"}`}>
          {filtered.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={conversations.length === 0 ? "Nenhuma conversa ainda" : "Nada por aqui"}
                description={
                  conversations.length === 0
                    ? "As conversas do WhatsApp aparecem aqui."
                    : "Nenhuma conversa nesse filtro no momento."
                }
              />
            </div>
          ) : (
            filtered.map((c) => {
              const s = STATUS_LABEL[c.status];
              const InboxIcon = INBOX_ICON[c.inboxCategory];
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`block w-full border-b border-line px-4 py-3 text-left transition-colors hover:bg-line/20 ${
                    selectedId === c.id ? "bg-primary-light/50" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-ink-900">{c.contactName ?? c.contactPhone}</p>
                    <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="text-xs text-ink-400">
                      {new Date(c.lastMessageAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </p>
                    {c.inboxCategory !== "resolved" && (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-ink-500">
                        <InboxIcon className="h-3 w-3" /> {INBOX_CATEGORY_LABEL[c.inboxCategory]}
                      </span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Conversa selecionada — some no mobile enquanto nada está selecionado */}
        <div className={`flex min-w-0 flex-1 flex-col ${selectedId ? "flex" : "hidden sm:flex"}`}>
          {selected ? (
            <ConversationDetail
              key={selected.id}
              conversation={selected}
              onBack={() => setSelectedId(null)}
              onStatusChanged={loadList}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="text-sm text-ink-400">Selecione uma conversa à esquerda.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

