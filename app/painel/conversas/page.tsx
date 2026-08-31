"use client";
// Painel: conversas do WhatsApp — o mínimo necessário pra operação da Livia,
// não uma reconstrução do WhatsApp Web. Lista à esquerda, conversa
// selecionada à direita, status visível, Assumir/Devolver.
//
// Em mobile, lista e conversa não cabem lado a lado: mostra uma coisa de
// cada vez (lista, ou a conversa com um botão "Voltar").
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bot, UserCheck, AlertCircle, RefreshCw } from "lucide-react";
import type { Conversation, Message } from "@/types";
import { Button } from "@/components/ui/Button";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { PageHeader } from "@/components/ui/PageHeader";

const STATUS_LABEL: Record<Conversation["status"], { label: string; tone: StatusTone; icon: typeof Bot }> = {
  bot: { label: "Livia atendendo", tone: "success", icon: Bot },
  handoff: { label: "Precisa de atendimento", tone: "warning", icon: AlertCircle },
  human: { label: "Atendimento humano", tone: "info", icon: UserCheck },
  closed: { label: "Encerrada", tone: "neutral", icon: Bot },
};

const LIST_REFRESH_MS = 15000;

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  if (error) return <ErrorState onRetry={loadList} />;
  if (!conversations) return <LoadingState />;

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Conversas"
        description="Acompanhe o que a Livia está conversando no WhatsApp e assuma quando precisar."
        action={
          <Button variant="secondary" size="sm" onClick={loadList}>
            <RefreshCw className="h-3.5 w-3.5" /> Atualizar
          </Button>
        }
      />

      <div className="flex overflow-hidden rounded-card border border-line bg-white" style={{ height: "70vh" }}>
        {/* Lista — some no mobile quando uma conversa está aberta */}
        <div className={`w-full shrink-0 overflow-y-auto border-r border-line sm:w-72 ${selectedId ? "hidden sm:block" : "block"}`}>
          {conversations.length === 0 ? (
            <div className="p-4">
              <EmptyState title="Nenhuma conversa ainda" description="As conversas do WhatsApp aparecem aqui." />
            </div>
          ) : (
            conversations.map((c) => {
              const s = STATUS_LABEL[c.status];
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
                  <p className="mt-1 text-xs text-ink-400">
                    {new Date(c.lastMessageAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </p>
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

function ConversationDetail({
  conversation,
  onBack,
  onStatusChanged,
}: {
  conversation: Conversation;
  onBack: () => void;
  onStatusChanged: () => void;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(conversation.status);

  const loadMessages = useCallback(() => {
    fetch(`/api/conversations/${conversation.id}`)
      .then((r) => r.json())
      .then((j) => {
        setMessages(j.messages ?? []);
        if (j.conversation?.status) setStatus(j.conversation.status);
      })
      .catch(() => setMessages([]));
  }, [conversation.id]);

  useEffect(() => {
    loadMessages();
    const interval = setInterval(loadMessages, LIST_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadMessages]);

  async function act(action: "assume" | "return") {
    setBusy(true);
    const res = await fetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      const j = await res.json();
      setStatus(j.status);
      onStatusChanged();
    }
    setBusy(false);
  }

  const s = STATUS_LABEL[status];

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <button onClick={onBack} className="rounded-control p-1.5 text-ink-500 hover:bg-line/30 sm:hidden">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-900">{conversation.contactName ?? conversation.contactPhone}</p>
            <p className="text-xs text-ink-400">{conversation.contactPhone}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
          {status === "human" ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("return")}>
              Devolver para Livia
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => act("assume")}>
              Assumir conversa
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {messages === null ? (
          <LoadingState />
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-ink-400">Nenhuma mensagem ainda.</p>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const fromCustomer = message.role === "customer";
  return (
    <div className={`flex ${fromCustomer ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] rounded-card px-3 py-2 text-sm ${
          fromCustomer ? "bg-line/40 text-ink-900" : message.role === "agent" ? "bg-info text-white" : "bg-primary text-white"
        }`}
      >
        <p className="whitespace-pre-wrap">{message.text}</p>
        <p className={`mt-1 text-[10px] ${fromCustomer ? "text-ink-400" : "text-white/70"}`}>
          {new Date(message.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          {!fromCustomer && (message.role === "agent" ? " · atendente" : " · Livia")}
        </p>
      </div>
    </div>
  );
}
