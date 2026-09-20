"use client";
// CRM automático — Passo 10. O perfil vem do atendimento, com a exceção
// deliberada da importação explícita de contatos para Campanhas. A lista usa
// CustomerProfile + Conversation.summary + PendingTask, montado por
// lib/dashboard.ts, sem criar um CRM paralelo.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { User, Clock, Briefcase, MapPin, Phone, Plus, X } from "lucide-react";
import type { CustomerProfile, IntentType, MarketingOptInSource, PendingTask } from "@/types";
import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Skeleton, SkeletonList } from "@/components/ui/Skeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { INTENT_LABEL } from "@/components/lib/labels";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";

const RELATIONSHIP_LABEL: Record<string, { label: string; tone: StatusTone }> = {
  active: { label: "Ativo", tone: "success" },
  recent: { label: "Recente", tone: "info" },
  inactive: { label: "Inativo", tone: "neutral" },
};

const MARKETING_LABEL: Record<string, { label: string; tone: StatusTone }> = {
  eligible: { label: "Elegível", tone: "success" },
  opted_out: { label: "Opt-out", tone: "neutral" },
  blocked: { label: "Bloqueado", tone: "danger" },
  without_consent: { label: "Sem consentimento", tone: "warning" },
};

function marketingStatus(profile: CustomerProfile): keyof typeof MARKETING_LABEL {
  return profile.marketingStatus ?? "without_consent";
}

interface CustomerDetail {
  profile: CustomerProfile;
  conversationSummary: string | null;
  conversationId: string | null;
  pendingTask: PendingTask | null;
  relationshipStatus: "active" | "recent" | "inactive";
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerProfile[] | null>(null);
  const [error, setError] = useState(false);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(() => {
    fetch("/api/customers")
      .then((r) => r.json())
      .then((j) => {
        setCustomers(j.customers ?? []);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorState onRetry={load} />;
  if (!customers)
    return (
      <div className="mx-auto max-w-5xl">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mb-4 mt-2 h-4 w-80" />
        <div className="flex h-[calc(100dvh-11rem)] min-h-[520px] overflow-hidden rounded-card border border-line bg-white shadow-e2">
          <div className="w-full shrink-0 border-r border-line sm:w-80">
            <SkeletonList rows={7} />
          </div>
          <div className="hidden flex-1 sm:block" />
        </div>
      </div>
    );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Clientes"
        description="Histórico e contexto dos seus clientes em um só lugar, com controle de consentimento para campanhas."
        action={<Button onClick={() => setImportOpen((open) => !open)}><Plus className="h-4 w-4" /> Adicionar contatos</Button>}
      />

      {importOpen ? <ContactImportForm onImported={load} onClose={() => setImportOpen(false)} /> : null}

      <div className="flex h-[calc(100dvh-11rem)] min-h-[460px] overflow-hidden rounded-card border border-line bg-white shadow-e1">
        <div className={`w-full shrink-0 overflow-y-auto border-r border-line sm:w-80 ${selectedPhone ? "hidden sm:block" : "block"}`}>
          {customers.length === 0 ? (
            <div className="p-4">
              <EmptyState title="Nenhum cliente ainda" description="Assim que a Livia atender alguém, o perfil aparece aqui." />
            </div>
          ) : (
            customers.map((c) => (
              <button
                key={c.phone}
                onClick={() => setSelectedPhone(c.phone)}
                className={`relative flex w-full items-center gap-3 border-b border-line px-4 py-3.5 text-left transition-colors duration-150 hover:bg-ink-50 ${
                  selectedPhone === c.phone ? "bg-primary-light/60 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-primary" : ""
                }`}
              >
                <Avatar name={c.name} phone={c.phone} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink-900">{c.name || c.phone}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {c.lastIntent && INTENT_LABEL[c.lastIntent] ? `${INTENT_LABEL[c.lastIntent]} · ` : ""}
                    {relativeTime(c.lastInteractionAt)}
                  </p>
                </div>
                <MarketingBadge profile={c} />
              </button>
            ))
          )}
        </div>

        <div className={`flex min-w-0 flex-1 flex-col overflow-y-auto ${selectedPhone ? "flex" : "hidden sm:flex"}`}>
          {selectedPhone ? (
            <CustomerDetailPanel phone={selectedPhone} onBack={() => setSelectedPhone(null)} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={<User className="h-5 w-5" />}
                title="Selecione um cliente"
                description="Escolha um cliente à esquerda para ver o perfil."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CustomerDetailPanel({ phone, onBack }: { phone: string; onBack: () => void }) {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setDetail(null);
    setNotFound(false);
    fetch(`/api/customers/${encodeURIComponent(phone)}`)
      .then((r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        return r.json();
      })
      .then((j) => j && setDetail(j))
      .catch(() => setNotFound(true));
  }, [phone]);

  if (notFound) return <p className="p-6 text-sm text-ink-400">Cliente não encontrado.</p>;
  if (!detail) return <LoadingState />;

  const { profile, conversationSummary, conversationId, pendingTask, relationshipStatus } = detail;
  const rel = RELATIONSHIP_LABEL[relationshipStatus];

  return (
    <div className="p-5 sm:p-6">
      <button onClick={onBack} className="mb-3 text-xs font-semibold text-ink-400 hover:text-primary sm:hidden">
        ← Voltar
      </button>

      <div className="mb-5 flex items-start justify-between gap-3 border-b border-line pb-5">
        <div className="flex items-center gap-3">
          <Avatar name={profile.name} phone={profile.phone} size="lg" />
          <div>
            <p className="text-lg font-bold text-ink-900">{profile.name || profile.phone}</p>
            <p className="flex items-center gap-1 text-xs text-ink-400">
              <Phone className="h-3 w-3" /> {profile.phone}
            </p>
          </div>
        </div>
        <StatusBadge tone={rel.tone}>{rel.label}</StatusBadge>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <Row icon={<Phone className="h-4 w-4" />} label="Marketing" value={MARKETING_LABEL[marketingStatus(profile)].label} />
        <Row icon={<Clock className="h-4 w-4" />} label="Última interação" value={relativeTime(profile.lastInteractionAt)} />
        {profile.lastIntent && (
          <Row icon={<User className="h-4 w-4" />} label="Última intenção" value={INTENT_LABEL[profile.lastIntent] ?? profile.lastIntent} />
        )}
        {profile.lastService && <Row icon={<Briefcase className="h-4 w-4" />} label="Último serviço" value={profile.lastService} />}
        {profile.preferredProfessional && <Row icon={<User className="h-4 w-4" />} label="Profissional preferido" value={profile.preferredProfessional} />}
        {profile.preferredTime && <Row icon={<Clock className="h-4 w-4" />} label="Horário preferido" value={profile.preferredTime} />}
        {profile.frequentAddress && <Row icon={<MapPin className="h-4 w-4" />} label="Endereço frequente" value={profile.frequentAddress} />}
      </div>

      {pendingTask && (
        <Card className="mt-4 border-warning/30 bg-warning-bg/20">
          <p className="text-xs font-semibold text-warning-fg">Pendência atual</p>
          <p className="mt-1 text-sm text-ink-700">{pendingTask.waitingFor}</p>
        </Card>
      )}

      {conversationSummary && (
        <Card className="mt-4">
          <p className="mb-1 text-xs font-semibold text-ink-500">Resumo da conversa</p>
          <p className="whitespace-pre-wrap text-sm text-ink-700">{conversationSummary}</p>
        </Card>
      )}

      {conversationId && (
        <Link
          href={`/painel/conversas?conversa=${conversationId}`}
          className="mt-4 inline-block text-sm font-semibold text-primary hover:underline"
        >
          Ver conversa completa →
        </Link>
      )}
    </div>
  );
}

function MarketingBadge({ profile }: { profile: CustomerProfile }) {
  const status = MARKETING_LABEL[marketingStatus(profile)];
  return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
}

type ImportRow = { name: string; phone: string };
const emptyRow = (): ImportRow => ({ name: "", phone: "" });
const OPT_IN_SOURCES: Array<{ value: MarketingOptInSource; label: string }> = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "website_form", label: "Formulário do site" },
  { value: "physical_store", label: "Loja física" },
  { value: "crm_import", label: "Importação de CRM" },
  { value: "other", label: "Outra origem" },
];

function ContactImportForm({ onImported, onClose }: { onImported: () => void; onClose: () => void }) {
  const [rows, setRows] = useState<ImportRow[]>([emptyRow()]);
  const [confirmedMarketingOptIn, setConfirmedMarketingOptIn] = useState(false);
  const [source, setSource] = useState<MarketingOptInSource>("whatsapp");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function updateRow(index: number, key: keyof ImportRow, value: string) {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
  }

  async function submit() {
    const contacts = rows.map((row) => ({ phone: row.phone.trim(), ...(row.name.trim() ? { name: row.name.trim() } : {}) }));
    if (contacts.length === 0 || contacts.some((contact) => !contact.phone)) {
      setError("Informe o telefone de cada contato.");
      return;
    }
    if (!confirmedMarketingOptIn) {
      setError("Confirme a autorização de marketing antes de adicionar contatos elegíveis.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/customers/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contacts, declaration: { confirmedMarketingOptIn: true, source } }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; result?: { created?: number; eligible?: number; alreadyEligible?: number; duplicates?: number; protected?: number } };
      if (!response.ok) throw new Error(body.error ?? "Não foi possível adicionar os contatos.");
      const imported = body.result;
      const newlyEligible = imported?.eligible ?? 0;
      const alreadyEligible = imported?.alreadyEligible ?? 0;
      const protectedContacts = imported?.protected ?? 0;
      const details = [
        `${newlyEligible} novo(s) ou atualizado(s)`,
        ...(alreadyEligible ? [`${alreadyEligible} já elegível(is)`] : []),
        ...(protectedContacts ? [`${protectedContacts} protegido(s) mantido(s) sem alteração`] : []),
      ];
      setResult(`${newlyEligible + alreadyEligible} contato(s) elegível(is) após a importação: ${details.join("; ")}.`);
      setRows([emptyRow()]);
      setConfirmedMarketingOptIn(false);
      onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível adicionar os contatos.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-6 border-primary/20 bg-primary-light/10 shadow-e2">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold text-ink-900">Adicionar contatos para campanhas</h2>
          <p className="mt-1 text-sm text-ink-500">Os contatos são gravados somente no estabelecimento conectado à sua sessão.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /> Fechar</Button>
      </div>
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={index} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <div><Label>Nome <span className="font-normal text-ink-400">(opcional)</span></Label><Input value={row.name} onChange={(event) => updateRow(index, "name", event.target.value)} placeholder="Nome do contato" /></div>
            <div><Label>Telefone</Label><Input value={row.phone} onChange={(event) => updateRow(index, "phone", event.target.value)} placeholder="(14) 99999-9999" inputMode="tel" /></div>
            {rows.length > 1 ? <Button className="self-end" variant="secondary" size="sm" onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}>Remover</Button> : <span />}
          </div>
        ))}
      </div>
      <Button className="mt-3" variant="ghost" size="sm" onClick={() => setRows((current) => [...current, emptyRow()])}><Plus className="h-4 w-4" /> Adicionar outra linha</Button>
      <div className="mt-4 max-w-sm"><Label>Origem do consentimento</Label><Select value={source} onChange={(event) => setSource(event.target.value as MarketingOptInSource)}>{OPT_IN_SOURCES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div>
      <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={confirmedMarketingOptIn} onChange={(event) => setConfirmedMarketingOptIn(event.target.checked)} className="mt-0.5 h-4 w-4" />
        <span>Confirmo que possuo autorização válida de cada contato para receber mensagens de marketing pelo WhatsApp.</span>
      </label>
      <p className="mt-2 text-xs text-ink-400">Adicionar um contato não cria consentimento automaticamente. Sem esta confirmação, nenhum contato é marcado como elegível.</p>
      {error ? <p role="alert" className="mt-3 rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-fg">{error}</p> : null}
      {result ? <p role="status" className="mt-3 rounded-control bg-success-bg px-3 py-2 text-sm text-success-fg">{result}</p> : null}
      <Button className="mt-4" loading={submitting} disabled={!confirmedMarketingOptIn} onClick={() => void submit()}>Adicionar contatos elegíveis</Button>
    </Card>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-ink-400">{icon}</span>
      <div>
        <p className="text-xs text-ink-400">{label}</p>
        <p className="font-medium text-ink-900">{value}</p>
      </div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "agora mesmo";
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `há ${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return "ontem";
  if (diffD < 30) return `há ${diffD} dias`;
  return new Date(ts).toLocaleDateString("pt-BR");
}
