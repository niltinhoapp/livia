"use client";
// Extraído de page.tsx (não é rota — Next.js só aceita os exports
// especiais nomeados em page.tsx; adicionar `export function
// ConversationDetail` lá quebrava `tsc --noEmit` via .next/types). Nenhuma
// mudança de comportamento nesta extração, só de arquivo.
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, GraduationCap, UserCheck, AlertCircle, Bot } from "lucide-react";
import type { Conversation, Message } from "@/types";
import { Button } from "@/components/ui/Button";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { LoadingState } from "@/components/ui/States";
import { TeachDialog } from "@/components/knowledge/TeachDialog";

export const STATUS_LABEL: Record<Conversation["status"], { label: string; tone: StatusTone; icon: typeof Bot }> = {
  bot: { label: "Livia atendendo", tone: "success", icon: Bot },
  handoff: { label: "Precisa de atendimento", tone: "warning", icon: AlertCircle },
  human: { label: "Atendimento humano", tone: "info", icon: UserCheck },
  closed: { label: "Encerrada", tone: "neutral", icon: Bot },
};

export function ConversationDetail({
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
  // Passo 8 — "Ensinar a Livia" a partir de uma conversa: qual mensagem do
  // bot está sendo corrigida agora (null = diálogo fechado).
  const [teachDefaultQuestion, setTeachDefaultQuestion] = useState<string | null>(null);
  const [teachOpen, setTeachOpen] = useState(false);
  const [teachSaved, setTeachSaved] = useState(false);

  const loadMessages = useCallback(() => {
    fetch(`/api/conversations/${conversation.id}`)
      .then((r) => r.json())
      .then((j) => {
        setMessages(j.messages ?? []);
        if (j.conversation?.status) setStatus(j.conversation.status);
      })
      .catch(() => setMessages([]));
  }, [conversation.id]);

  // Fix #1 da auditoria de consumo do Firestore (03/09/2026): isto rebuscava
  // até 100 mensagens a cada 15s, MESMO sem nenhuma mensagem nova — foi a
  // maior fonte isolada de leitura do dia (uma conversa aberta por horas
  // gerava dezenas de milhares de reads sozinha).
  //
  // A lista (`conversations`, no componente pai) já é repolada a cada 15s e
  // traz `lastMessageAt` de cada conversa — um documento, não até 100. Este
  // efeito depende de `conversation.lastMessageAt` (não de um objeto ou de um
  // timer): o React só dispara de novo quando esse NÚMERO muda de valor, o
  // que só acontece quando uma mensagem nova de verdade chega. Rodar também
  // no id da conversa cobre a troca de conversa e a seleção inicial — nesse
  // caso lastMessageAt também "muda" (de undefined/outro valor pro valor
  // atual), então um único efeito cobre os dois casos sem duplicar lógica.
  //
  // Isto não piora a latência de "ver mensagem nova": antes e depois, o teto
  // de atraso é o mesmo intervalo de 15s do poll da LISTA — só deixamos de
  // pagar a leitura cara quando ela não traria nada de novo.
  useEffect(() => {
    loadMessages();
  }, [loadMessages, conversation.lastMessageAt]);

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
      // Ação local que sabidamente altera a conversa (a Livia para de
      // responder, ou volta a responder) — atualiza o histórico agora, sem
      // esperar o próximo poll da lista mudar lastMessageAt. Mesmo mecanismo
      // que uma futura funcionalidade de enviar mensagem pelo painel usaria.
      loadMessages();
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
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                // Pergunta do cliente logo antes desta resposta — pré-
                // preenche o formulário de correção; ausente se a resposta
                // não veio logo depois de uma mensagem do cliente.
                precedingCustomerText={
                  m.role === "bot" && messages[i - 1]?.role === "customer" ? messages[i - 1]!.text : undefined
                }
                onCorrect={(question) => {
                  setTeachDefaultQuestion(question ?? "");
                  setTeachOpen(true);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <TeachDialog
        open={teachOpen}
        defaultQuestion={teachDefaultQuestion ?? undefined}
        conversationId={conversation.id}
        onClose={() => setTeachOpen(false)}
        onSaved={() => {
          setTeachOpen(false);
          setTeachSaved(true);
          setTimeout(() => setTeachSaved(false), 3000);
        }}
      />
      {teachSaved && (
        <p className="border-t border-line bg-success-bg px-4 py-2 text-center text-xs font-semibold text-success-fg">
          Correção salva — a Livia já usa essa informação nas próximas conversas.
        </p>
      )}
    </>
  );
}

function MessageBubble({
  message,
  precedingCustomerText,
  onCorrect,
}: {
  message: Message;
  precedingCustomerText?: string;
  onCorrect: (question: string | undefined) => void;
}) {
  const fromCustomer = message.role === "customer";
  return (
    <div className={`flex ${fromCustomer ? "justify-start" : "justify-end"}`}>
      <div className="max-w-[80%]">
        <div
          className={`rounded-card px-3 py-2 text-sm ${
            fromCustomer ? "bg-line/40 text-ink-900" : message.role === "agent" ? "bg-info text-white" : "bg-primary text-white"
          }`}
        >
          <p className="whitespace-pre-wrap">{message.text}</p>
          <p className={`mt-1 text-[10px] ${fromCustomer ? "text-ink-400" : "text-white/70"}`}>
            {new Date(message.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            {!fromCustomer && (message.role === "agent" ? " · atendente" : " · Livia")}
          </p>
        </div>
        {message.role === "bot" && (
          <button
            onClick={() => onCorrect(precedingCustomerText)}
            className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-ink-400 hover:text-primary"
          >
            <GraduationCap className="h-3 w-3" /> Corrigir
          </button>
        )}
      </div>
    </div>
  );
}
