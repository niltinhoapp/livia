// Tabela de campanhas — mesmo padrão visual de tabela responsiva já usado
// no projeto (desktop: <table>; mobile: cartões empilhados), reaproveitando
// os tokens de components/ui (StatusBadge, cores/bordas do design system).
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { Campaign } from "@/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CAMPAIGN_STATUS_LABEL } from "@/components/lib/labels";

function formatDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toLocaleDateString("pt-BR");
}

export function CampaignsTable({ campaigns }: { campaigns: Campaign[] }) {
  return (
    <>
      {/* Desktop: tabela */}
      <div className="hidden overflow-hidden rounded-control border border-line sm:block">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-2.5">Campanha</th>
              <th className="px-4 py-2.5">Template</th>
              <th className="px-4 py-2.5">Público</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Enviados</th>
              <th className="px-4 py-2.5 text-right">Entregues</th>
              <th className="px-4 py-2.5 text-right">Lidos</th>
              <th className="px-4 py-2.5 text-right">Respostas</th>
              <th className="px-4 py-2.5">Data</th>
              <th className="px-4 py-2.5 text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {campaigns.map((c) => {
              const status = CAMPAIGN_STATUS_LABEL[c.status];
              return (
                <tr key={c.id}>
                  <td className="px-4 py-3 font-medium text-ink-900">{c.name}</td>
                  <td className="px-4 py-3 text-ink-500">{c.template?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-ink-500">
                    {c.audience ? `${c.audience.eligibleRecipientCount} contatos` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </td>
                  <td className="px-4 py-3 text-right text-ink-500">{c.counters.sent}</td>
                  <td className="px-4 py-3 text-right text-ink-500">{c.counters.delivered}</td>
                  <td className="px-4 py-3 text-right text-ink-500">{c.counters.read}</td>
                  <td className="px-4 py-3 text-right text-ink-500">{c.counters.replied}</td>
                  <td className="px-4 py-3 text-ink-500">{formatDate(c.scheduledAt ?? c.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/painel/campanhas/${c.id}`}
                      className="inline-flex items-center gap-0.5 text-sm font-semibold text-primary hover:underline"
                    >
                      Ver <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: cartões empilhados */}
      <div className="space-y-2 sm:hidden">
        {campaigns.map((c) => {
          const status = CAMPAIGN_STATUS_LABEL[c.status];
          return (
            <Link
              key={c.id}
              href={`/painel/campanhas/${c.id}`}
              className="block rounded-control border border-line p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-ink-900">{c.name}</p>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </div>
              <p className="mt-1 text-xs text-ink-400">
                {c.template?.name ?? "Sem template"} · {formatDate(c.scheduledAt ?? c.createdAt)}
              </p>
              <p className="mt-1 text-xs text-ink-500">
                {c.counters.sent} enviados · {c.counters.delivered} entregues · {c.counters.read} lidos ·{" "}
                {c.counters.replied} respostas
              </p>
            </Link>
          );
        })}
      </div>
    </>
  );
}
