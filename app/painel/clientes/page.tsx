"use client";
// CRM automático — Passo 10. O perfil é consequência do atendimento (nunca
// uma ficha pra preencher manualmente): tudo aqui vem de CustomerProfile
// (Pacote 1) + Conversation.summary + PendingTask, montado por
// lib/dashboard.ts. Mesmo padrão visual de /painel/conversas (lista +
// detalhe), pra manter o painel coerente sem introduzir um componente novo.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { User, Clock, Briefcase, MapPin, Phone } from "lucide-react";
import type { CustomerProfile, IntentType, PendingTask } from "@/types";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { PageHeader } from "@/components/ui/PageHeader";
import { INTENT_LABEL } from "@/components/lib/labels";

const RELATIONSHIP_LABEL: Record<string, { label: string; tone: StatusTone }> = {
  active: { label: "Ativo", tone: "success" },
  recent: { label: "Recente", tone: "info" },
  inactive: { label: "Inativo", tone: "neutral" },
};

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
  if (!customers) return <LoadingState />;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Clientes"
        description="O perfil de cada cliente é construído automaticamente pelo atendimento da Livia — nada aqui precisa ser preenchido à mão."
      />

      <div className="flex overflow-hidden rounded-card border border-line bg-white" style={{ height: "70vh" }}>
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
                className={`block w-full border-b border-line px-4 py-3 text-left transition-colors hover:bg-line/20 ${
                  selectedPhone === c.phone ? "bg-primary-light/50" : ""
                }`}
              >
                <p className="truncate text-sm font-semibold text-ink-900">{c.name || c.phone}</p>
                <p className="mt-0.5 text-xs text-ink-400">
                  {c.lastIntent && INTENT_LABEL[c.lastIntent] ? `${INTENT_LABEL[c.lastIntent]} · ` : ""}
                  {relativeTime(c.lastInteractionAt)}
                </p>
              </button>
            ))
          )}
        </div>

        <div className={`flex min-w-0 flex-1 flex-col overflow-y-auto ${selectedPhone ? "flex" : "hidden sm:flex"}`}>
          {selectedPhone ? (
            <CustomerDetailPanel phone={selectedPhone} onBack={() => setSelectedPhone(null)} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="text-sm text-ink-400">Selecione um cliente à esquerda.</p>
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
    <div className="p-5">
      <button onClick={onBack} className="mb-3 text-xs font-semibold text-ink-400 hover:text-primary sm:hidden">
        ← Voltar
      </button>

      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-bold text-ink-900">{profile.name || profile.phone}</p>
          <p className="flex items-center gap-1 text-xs text-ink-400">
            <Phone className="h-3 w-3" /> {profile.phone}
          </p>
        </div>
        <StatusBadge tone={rel.tone}>{rel.label}</StatusBadge>
      </div>

      <div className="space-y-3 text-sm">
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
