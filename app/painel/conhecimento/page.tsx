"use client";
// Painel: base de conhecimento do estabelecimento.
// É aqui que o dono ensina a Livia — serviços, horários, endereço e FAQs.
// A IA responde SOMENTE com o que estiver cadastrado aqui.
//
// Tenant vem da sessão (cookie httpOnly criado no login); o painel só é
// renderizado se app/painel/layout.tsx confirmar uma sessão válida.
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { KnowledgeService, KnowledgeFaq } from "@/types";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState, ErrorState } from "@/components/ui/States";

type SaveState = "idle" | "loading" | "saving" | "saved" | "error";

export default function KnowledgePanel() {
  const [state, setState] = useState<SaveState>("loading");
  const [loadError, setLoadError] = useState(false);
  const [about, setAbout] = useState("");
  const [address, setAddress] = useState("");
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");
  const [services, setServices] = useState<KnowledgeService[]>([]);
  const [faqs, setFaqs] = useState<KnowledgeFaq[]>([]);

  const load = useCallback(() => {
    setLoadError(false);
    setState("loading");
    fetch("/api/knowledge")
      .then((r) => r.json())
      .then((d) => {
        const kb = d.knowledge;
        if (kb) {
          setAbout(kb.about ?? "");
          setAddress(kb.address ?? "");
          setHours(kb.hours ?? "");
          setNotes(kb.notes ?? "");
          setServices(kb.services ?? []);
          setFaqs(kb.faqs ?? []);
        }
        setState("idle");
      })
      .catch(() => {
        setLoadError(true);
        setState("idle");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    setState("saving");
    const res = await fetch("/api/knowledge", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ about, address, hours, notes, services, faqs }),
    });
    setState(res.ok ? "saved" : "error");
    if (res.ok) setTimeout(() => setState("idle"), 2000);
  }, [about, address, hours, notes, services, faqs]);

  if (state === "loading") return <LoadingState />;
  if (loadError) return <ErrorState onRetry={load} />;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="O que a Livia precisa saber"
        description="Quanto mais completo, melhor ela atende. A Livia só responde com base no que estiver aqui."
      />

      <Card className="mb-4">
        <Label>Sobre o negócio</Label>
        <Textarea
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder="Ex.: Clínica de fisioterapia especializada em reabilitação esportiva."
        />
      </Card>

      <Card className="mb-4 grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Endereço</Label>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Rua, número, bairro, cidade" />
        </div>
        <div>
          <Label hint="(texto que a Livia usa na conversa)">Horário de funcionamento</Label>
          <Input value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Seg-Sex 9h-18h, Sáb 9h-13h" />
        </div>
      </Card>

      <Card className="mb-4">
        <div className="mb-3 flex items-center justify-between">
          <strong className="text-sm font-semibold text-ink-900">Serviços</strong>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setServices([...services, { name: "", priceText: null, durationText: null, description: null }])}
          >
            <Plus className="h-3.5 w-3.5" /> Adicionar serviço
          </Button>
        </div>
        {services.length === 0 && <p className="text-sm text-ink-400">Nenhum serviço ainda.</p>}
        {services.map((s, i) => (
          <div key={i} className={i ? "mt-3 border-t border-line pt-3" : ""}>
            <div className="flex flex-wrap gap-2">
              <Input className="flex-1 basis-[200px]" value={s.name} onChange={(e) => upd(services, setServices, i, { name: e.target.value })} placeholder="Nome do serviço" />
              <Input className="flex-1 basis-[140px]" value={s.priceText ?? ""} onChange={(e) => upd(services, setServices, i, { priceText: e.target.value })} placeholder="Preço (ex.: a partir de R$ 80)" />
              <Input className="flex-1 basis-[100px]" value={s.durationText ?? ""} onChange={(e) => upd(services, setServices, i, { durationText: e.target.value })} placeholder="Duração" />
            </div>
            <Input className="mt-2" value={s.description ?? ""} onChange={(e) => upd(services, setServices, i, { description: e.target.value })} placeholder="Descrição (opcional)" />
            <button
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-danger-fg hover:underline"
              onClick={() => setServices(services.filter((_, x) => x !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remover
            </button>
          </div>
        ))}
      </Card>

      <Card className="mb-4">
        <div className="mb-3 flex items-center justify-between">
          <strong className="text-sm font-semibold text-ink-900">Perguntas frequentes</strong>
          <Button variant="ghost" size="sm" onClick={() => setFaqs([...faqs, { question: "", answer: "" }])}>
            <Plus className="h-3.5 w-3.5" /> Adicionar pergunta
          </Button>
        </div>
        {faqs.length === 0 && <p className="text-sm text-ink-400">Nenhuma pergunta ainda.</p>}
        {faqs.map((f, i) => (
          <div key={i} className={i ? "mt-3 border-t border-line pt-3" : ""}>
            <Input value={f.question} onChange={(e) => upd(faqs, setFaqs, i, { question: e.target.value })} placeholder="Pergunta (ex.: Vocês atendem convênio?)" />
            <Textarea className="mt-2 min-h-[56px]" value={f.answer} onChange={(e) => upd(faqs, setFaqs, i, { answer: e.target.value })} placeholder="Resposta" />
            <button
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-danger-fg hover:underline"
              onClick={() => setFaqs(faqs.filter((_, x) => x !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remover
            </button>
          </div>
        ))}
      </Card>

      <Card className="mb-6">
        <Label>Observações (pagamento, convênios, políticas…)</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: Aceitamos Pix e cartão. Convênios: Unimed, Bradesco Saúde." />
      </Card>

      <div className="flex items-center gap-4">
        <Button disabled={state === "saving"} onClick={save}>
          {state === "saving" ? "Salvando…" : "Salvar"}
        </Button>
        {state === "saved" && <span className="text-sm font-semibold text-success-fg">Salvo!</span>}
        {state === "error" && <span className="text-sm font-semibold text-danger-fg">Erro ao salvar.</span>}
      </div>
    </div>
  );
}

function upd<T>(arr: T[], setArr: (v: T[]) => void, i: number, patch: Partial<T>) {
  setArr(arr.map((item, x) => (x === i ? { ...item, ...patch } : item)));
}
