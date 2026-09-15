"use client";
// Plano e cobrança — camada VISUAL da assinatura do estabelecimento.
// NADA aqui fala com backend/Asaas/API: são apenas dados de exemplo (mock)
// para validar hierarquia, estados e responsividade. A integração real com
// os endpoints de billing será plugada depois, mantendo esta estrutura.
import { useEffect, useState } from "react";
import {
  Sparkles,
  Zap,
  Crown,
  Check,
  Download,
  ArrowRight,
  CalendarClock,
  Wallet,
  Receipt,
  AlertTriangle,
} from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

// -------------------------- MOCK (dados de exemplo) --------------------------
type Cycle = "monthly" | "annual";
type SubStatus = "active" | "past_due" | "canceled";

interface Plan {
  id: string;
  name: string;
  tagline: string;
  icon: typeof Zap;
  monthly: number; // R$/mês
  annual: number; // R$/mês quando cobrado no anual
  features: string[];
  highlight?: boolean;
}

const PLANS: Plan[] = [
  {
    id: "essencial",
    name: "Essencial",
    tagline: "Para começar a automatizar o atendimento",
    icon: Zap,
    monthly: 79,
    annual: 63,
    features: ["1 número de WhatsApp", "Atendimento pela IA", "Agenda e lembretes", "Até 500 conversas/mês"],
  },
  {
    id: "profissional",
    name: "Profissional",
    tagline: "O mais escolhido por quem já vende no WhatsApp",
    icon: Sparkles,
    monthly: 149,
    annual: 119,
    features: [
      "Tudo do Essencial",
      "Conversas ilimitadas",
      "Base de conhecimento avançada",
      "Relatórios do funil",
      "Suporte prioritário",
    ],
    highlight: true,
  },
  {
    id: "avancado",
    name: "Avançado",
    tagline: "Para operações com múltiplas unidades",
    icon: Crown,
    monthly: 299,
    annual: 239,
    features: ["Tudo do Profissional", "Múltiplos números", "Múltiplos atendentes", "Integrações e API", "Gerente de conta"],
  },
];

// Assinatura atual (exemplo). Troque `status` para ver os estados da tela.
const SUBSCRIPTION = {
  planId: "profissional",
  status: "active" as SubStatus,
  cycle: "monthly" as Cycle,
  nextBillingLabel: "10 de outubro de 2026",
  amountLabel: "R$ 149,00",
  paymentLabel: "Cartão de crédito •••• 4242",
};

interface Invoice {
  id: string;
  dateLabel: string;
  amountLabel: string;
  status: "paid" | "pending" | "failed";
}

const INVOICES: Invoice[] = [
  { id: "INV-2026-009", dateLabel: "10 set 2026", amountLabel: "R$ 149,00", status: "paid" },
  { id: "INV-2026-008", dateLabel: "10 ago 2026", amountLabel: "R$ 149,00", status: "paid" },
  { id: "INV-2026-007", dateLabel: "10 jul 2026", amountLabel: "R$ 149,00", status: "pending" },
  { id: "INV-2026-006", dateLabel: "10 jun 2026", amountLabel: "R$ 149,00", status: "failed" },
  { id: "INV-2026-005", dateLabel: "10 mai 2026", amountLabel: "R$ 149,00", status: "paid" },
];

const INVOICE_META: Record<Invoice["status"], { label: string; tone: StatusTone }> = {
  paid: { label: "Pago", tone: "success" },
  pending: { label: "Pendente", tone: "warning" },
  failed: { label: "Falhou", tone: "danger" },
};

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

// ------------------------------- Página --------------------------------------
export default function PlanoPage() {
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [loading, setLoading] = useState(true);

  // Simula um carregamento breve só para exibir o estado de skeleton
  // (não há chamada real — dados são mock).
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 500);
    return () => clearTimeout(t);
  }, []);

  const current = PLANS.find((p) => p.id === SUBSCRIPTION.planId)!;

  if (loading) return <PlanoSkeleton />;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Plano e cobrança"
        description="Gerencie sua assinatura da Livia, forma de pagamento e histórico de faturas."
      />

      {SUBSCRIPTION.status !== "active" && (
        <div className="mb-5 flex items-start gap-3 rounded-control border border-danger/30 bg-danger-bg/40 px-4 py-3 text-sm text-danger-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">
              {SUBSCRIPTION.status === "past_due" ? "Pagamento pendente" : "Assinatura cancelada"}
            </p>
            <p className="mt-0.5 text-danger-fg/90">
              {SUBSCRIPTION.status === "past_due"
                ? "Não conseguimos processar a última cobrança. Atualize a forma de pagamento para manter a Livia ativa."
                : "Sua assinatura está inativa. Reative um plano para a Livia voltar a atender."}
            </p>
          </div>
        </div>
      )}

      {/* -------- Plano atual (destaque) -------- */}
      <Card className="mb-5 overflow-hidden border-primary/20 bg-gradient-to-br from-primary-light/50 to-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-primary text-white shadow-e2">
              <current.icon className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-lg font-bold text-ink-900">Plano {current.name}</p>
                <StatusBadge tone="success">Ativo</StatusBadge>
              </div>
              <p className="mt-0.5 text-sm text-ink-500">
                Próxima cobrança em <span className="font-medium text-ink-700">{SUBSCRIPTION.nextBillingLabel}</span>
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-ink-900">{SUBSCRIPTION.amountLabel}</p>
            <p className="text-xs text-ink-400">por mês</p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button className="w-full sm:w-auto">Gerenciar assinatura</Button>
          <Button variant="secondary" className="w-full sm:w-auto">
            Atualizar pagamento
          </Button>
        </div>
      </Card>

      {/* -------- Resumo -------- */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Próxima cobrança"
          value={SUBSCRIPTION.amountLabel}
          tone="info"
          icon={<CalendarClock className="h-5 w-5" />}
          footer={<p className="text-xs text-ink-400">{SUBSCRIPTION.nextBillingLabel}</p>}
        />
        <StatCard
          label="Forma de pagamento"
          value="•••• 4242"
          tone="primary"
          icon={<Wallet className="h-5 w-5" />}
          footer={
            <button className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
              Trocar cartão <ArrowRight className="h-3.5 w-3.5" />
            </button>
          }
        />
        <StatCard
          label="Faturas pagas"
          value="8"
          tone="success"
          icon={<Receipt className="h-5 w-5" />}
          footer={<p className="text-xs text-ink-400">nos últimos 12 meses</p>}
        />
      </div>

      {/* -------- Escolher plano -------- */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="mb-0">Mudar de plano</CardTitle>
        <SegmentedControl<Cycle>
          className="w-full max-w-[260px]"
          value={cycle}
          onChange={setCycle}
          items={[
            { id: "monthly", label: "Mensal" },
            { id: "annual", label: "Anual · -20%" },
          ]}
        />
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {PLANS.map((plan) => {
          const isCurrent = plan.id === SUBSCRIPTION.planId;
          const price = cycle === "monthly" ? plan.monthly : plan.annual;
          const Icon = plan.icon;
          return (
            <Card
              key={plan.id}
              className={`relative flex flex-col ${plan.highlight ? "border-primary ring-1 ring-primary/30" : ""}`}
            >
              {plan.highlight && (
                <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                  <Badge tone="primary" className="shadow-e1">
                    <Sparkles className="h-3 w-3" /> Mais escolhido
                  </Badge>
                </div>
              )}
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-9 w-9 items-center justify-center rounded-full ${
                    plan.highlight ? "bg-primary text-white" : "bg-primary-light text-primary"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <p className="text-base font-bold text-ink-900">{plan.name}</p>
              </div>
              <p className="mt-2 min-h-[40px] text-sm text-ink-500">{plan.tagline}</p>

              <div className="mt-3 flex items-end gap-1">
                <span className="text-3xl font-bold text-ink-900">{brl(price)}</span>
                <span className="mb-1 text-sm text-ink-400">/mês</span>
              </div>
              {cycle === "annual" && (
                <p className="mt-1 text-xs text-success-fg">Cobrado {brl(price * 12)} por ano</p>
              )}

              <ul className="mt-4 space-y-2">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-ink-700">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-fg" aria-hidden />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-5 pt-1">
                {isCurrent ? (
                  <Button variant="secondary" className="w-full" disabled>
                    Plano atual
                  </Button>
                ) : (
                  <Button variant={plan.highlight ? "primary" : "secondary"} className="w-full">
                    Escolher {plan.name}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* -------- Histórico de faturas -------- */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <CardTitle className="mb-0">Histórico de faturas</CardTitle>
          <Button variant="secondary" size="sm">
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
                  {INVOICES.map((inv) => {
                    const m = INVOICE_META[inv.status];
                    return (
                      <tr key={inv.id} className="hover:bg-ink-50">
                        <td className="px-4 py-3 font-medium text-ink-900">{inv.id}</td>
                        <td className="px-4 py-3 text-ink-500">{inv.dateLabel}</td>
                        <td className="px-4 py-3 font-medium text-ink-900">{inv.amountLabel}</td>
                        <td className="px-4 py-3">
                          <StatusBadge tone={m.tone}>{m.label}</StatusBadge>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline disabled:text-ink-300 disabled:no-underline"
                            disabled={inv.status !== "paid"}
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
              {INVOICES.map((inv) => {
                const m = INVOICE_META[inv.status];
                return (
                  <div key={inv.id} className="rounded-control border border-line p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-ink-900">{inv.amountLabel}</p>
                      <StatusBadge tone={m.tone}>{m.label}</StatusBadge>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <p className="text-xs text-ink-400">
                        {inv.id} · {inv.dateLabel}
                      </p>
                      <button
                        className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline disabled:text-ink-300 disabled:no-underline"
                        disabled={inv.status !== "paid"}
                      >
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
