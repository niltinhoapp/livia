"use client";
// Plano e cobrança — PRÉVIA VISUAL. Não há dados reais nem decisões
// comerciais aqui: nomes de plano, valores, benefícios e ações NÃO estão
// definidos. Tudo é placeholder neutro, claramente substituível quando o
// Billing real for conectado. Nenhuma ação chama backend/Asaas/API — todos os
// botões de ação ficam desabilitados nesta primeira versão visual.
import { useEffect, useState } from "react";
import { CreditCard, CalendarClock, Wallet, Receipt, Download, Info } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

// -------------------------- PLACEHOLDER (neutro) ----------------------------
// Estrutura de exemplo só para posicionar a UI. Valores/benefícios ficam como
// "a definir" — serão preenchidos pelo Billing real depois, sem mudar o layout.
type Cycle = "monthly" | "annual";

interface PlanSlot {
  id: string;
  name: string;
  // nº de linhas de "benefício a definir" a reservar visualmente
  featureLines: number;
}

const PLAN_SLOTS: PlanSlot[] = [
  { id: "a", name: "Plano A", featureLines: 3 },
  { id: "b", name: "Plano B", featureLines: 4 },
  { id: "c", name: "Plano C", featureLines: 5 },
];

interface InvoiceRow {
  id: string;
  dateLabel: string;
  status: "paid" | "pending" | "failed";
}

// Linhas de exemplo apenas para demonstrar a estrutura do histórico e os
// estados de fatura. Valores ficam como "—" (a definir).
const INVOICES: InvoiceRow[] = [
  { id: "—", dateLabel: "—", status: "paid" },
  { id: "—", dateLabel: "—", status: "pending" },
  { id: "—", dateLabel: "—", status: "failed" },
];

const INVOICE_META: Record<InvoiceRow["status"], { label: string; tone: StatusTone }> = {
  paid: { label: "Pago", tone: "success" },
  pending: { label: "Pendente", tone: "warning" },
  failed: { label: "Falhou", tone: "danger" },
};

// ------------------------------- Página --------------------------------------
export default function PlanoPage() {
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [loading, setLoading] = useState(true);

  // Simula um carregamento breve só para exibir o estado de skeleton
  // (não há chamada real — conteúdo é placeholder).
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 500);
    return () => clearTimeout(t);
  }, []);

  if (loading) return <PlanoSkeleton />;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Plano e cobrança"
        description="Gerencie sua assinatura da Livia, forma de pagamento e histórico de faturas."
      />

      {/* Aviso claro: prévia visual, nada definido/conectado ainda. */}
      <div className="mb-5 flex items-start gap-3 rounded-control border border-info/30 bg-info-bg/40 px-4 py-3 text-sm text-info-fg">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-semibold">Prévia visual</p>
          <p className="mt-0.5 text-info-fg/90">
            Planos, valores, benefícios e ações ainda não estão definidos. Esta tela mostra apenas a estrutura —
            os dados serão conectados ao sistema de cobrança depois.
          </p>
        </div>
      </div>

      {/* -------- Plano atual (estrutura em destaque) -------- */}
      <Card className="mb-5 border-primary/20 bg-gradient-to-br from-primary-light/40 to-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-primary text-white shadow-e2">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-lg font-bold text-ink-900">Seu plano</p>
                <StatusBadge tone="neutral">A definir</StatusBadge>
              </div>
              <p className="mt-0.5 text-sm text-ink-500">
                Próxima cobrança: <span className="font-medium text-ink-700">—</span>
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-ink-400">R$ —</p>
            <p className="text-xs text-ink-400">por mês</p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button className="w-full sm:w-auto" disabled>
            Gerenciar assinatura
          </Button>
          <Button variant="secondary" className="w-full sm:w-auto" disabled>
            Atualizar pagamento
          </Button>
        </div>
      </Card>

      {/* -------- Resumo -------- */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Próxima cobrança"
          value="—"
          tone="info"
          icon={<CalendarClock className="h-5 w-5" />}
          footer={<p className="text-xs text-ink-400">a definir</p>}
        />
        <StatCard
          label="Forma de pagamento"
          value="—"
          tone="primary"
          icon={<Wallet className="h-5 w-5" />}
          footer={<p className="text-xs text-ink-400">não configurada</p>}
        />
        <StatCard
          label="Faturas"
          value="—"
          tone="neutral"
          icon={<Receipt className="h-5 w-5" />}
          footer={<p className="text-xs text-ink-400">histórico abaixo</p>}
        />
      </div>

      {/* -------- Planos (estrutura) -------- */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="mb-0">Planos</CardTitle>
        <SegmentedControl<Cycle>
          className="w-full max-w-[240px]"
          value={cycle}
          onChange={setCycle}
          items={[
            { id: "monthly", label: "Mensal" },
            { id: "annual", label: "Anual" },
          ]}
        />
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {PLAN_SLOTS.map((plan) => (
          <Card key={plan.id} className="flex flex-col">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-light text-primary">
                <CreditCard className="h-4 w-4" />
              </div>
              <p className="text-base font-bold text-ink-900">{plan.name}</p>
            </div>
            <p className="mt-2 min-h-[40px] text-sm text-ink-400">Descrição a definir.</p>

            <div className="mt-3 flex items-end gap-1">
              <span className="text-3xl font-bold text-ink-400">R$ —</span>
              <span className="mb-1 text-sm text-ink-400">/mês</span>
            </div>

            {/* Benefícios a definir — placeholders neutros, sem afirmações */}
            <div className="mt-4 space-y-2.5">
              {Array.from({ length: plan.featureLines }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-200" aria-hidden />
                  <span className="h-2.5 rounded bg-ink-100" style={{ width: `${55 + ((i * 13) % 35)}%` }} aria-hidden />
                </div>
              ))}
              <p className="pt-1 text-xs text-ink-400">Benefícios a definir</p>
            </div>

            <div className="mt-5 pt-1">
              <Button variant="secondary" className="w-full" disabled>
                Em breve
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {/* -------- Histórico de faturas -------- */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <CardTitle className="mb-0">Histórico de faturas</CardTitle>
          <Button variant="secondary" size="sm" disabled>
            <Download className="h-3.5 w-3.5" /> Exportar
          </Button>
        </div>

        {INVOICES.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">Nenhuma fatura ainda.</p>
        ) : (
          <>
            {/* Desktop: tabela */}
            <div className="hidden overflow-hidden rounded-control border border-line sm:block">
              <table className="w-full text-sm">
                <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-ink-400">
                  <tr>
                    <th className="px-4 py-2.5">Fatura</th>
                    <th className="px-4 py-2.5">Data</th>
                    <th className="px-4 py-2.5">Valor</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5 text-right">Recibo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {INVOICES.map((inv, i) => {
                    const m = INVOICE_META[inv.status];
                    return (
                      <tr key={i}>
                        <td className="px-4 py-3 font-medium text-ink-500">{inv.id}</td>
                        <td className="px-4 py-3 text-ink-500">{inv.dateLabel}</td>
                        <td className="px-4 py-3 font-medium text-ink-500">R$ —</td>
                        <td className="px-4 py-3">
                          <StatusBadge tone={m.tone}>{m.label}</StatusBadge>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            className="inline-flex items-center gap-1 text-sm font-semibold text-ink-300"
                            disabled
                          >
                            <Download className="h-3.5 w-3.5" /> Baixar
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: cartões empilhados */}
            <div className="space-y-2 sm:hidden">
              {INVOICES.map((inv, i) => {
                const m = INVOICE_META[inv.status];
                return (
                  <div key={i} className="rounded-control border border-line p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-ink-500">R$ —</p>
                      <StatusBadge tone={m.tone}>{m.label}</StatusBadge>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <p className="text-xs text-ink-400">
                        {inv.id} · {inv.dateLabel}
                      </p>
                      <button className="inline-flex items-center gap-1 text-sm font-semibold text-ink-300" disabled>
                        <Download className="h-3.5 w-3.5" /> Baixar
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// Estado de carregamento — espelha a estrutura da página.
function PlanoSkeleton() {
  return (
    <div className="mx-auto max-w-4xl">
      <Skeleton className="h-7 w-52" />
      <Skeleton className="mb-6 mt-2 h-4 w-96 max-w-full" />
      <Skeleton className="mb-5 h-40 w-full rounded-card" />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-80 w-full rounded-card" />
        ))}
      </div>
    </div>
  );
}
