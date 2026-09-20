"use client";
// Tabela de campanhas — mesmo padrão visual de tabela responsiva já usado
// no projeto (desktop: <table>; mobile: cartões empilhados), reaproveitando
// os tokens de components/ui (StatusBadge, cores/bordas do design system).
import Link from "next/link";
import { useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import type { Campaign } from "@/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CAMPAIGN_STATUS_LABEL } from "@/components/lib/labels";

function formatDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toLocaleDateString("pt-BR");
}

export function CampaignsTable({ campaigns, onDeleted }: { campaigns: Campaign[]; onDeleted?: (id: string) => void }) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function deleteDraft(campaign: Campaign) {
    if (campaign.status !== "draft" || deletingId) return;
    if (!window.confirm(`Excluir o rascunho "${campaign.name}"?`)) return;
    setDeletingId(campaign.id);
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        window.alert(body.error ?? "Não foi possível excluir o rascunho.");
        return;
      }
      onDeleted?.(campaign.id);
    } catch {
      window.alert("Não foi possível excluir o rascunho.");
    } finally {
      setDeletingId(null);
    }
  }
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
                    <div className="inline-flex items-center gap-3">
                      {c.status === "draft" && (
                        <button
                          type="button"
                          onClick={() => void deleteDraft(c)}
                          disabled={deletingId === c.id}
                          className="inline-flex items-center gap-1 text-sm font-semibold text-danger hover:underline disabled:opacity-50"
                          aria-label={`Excluir rascunho ${c.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> {deletingId === c.id ? "Excluindo..." : "Excluir"}
                        </button>
                      )}
                      <Link
                        href={`/painel/campanhas/${c.id}`}
                        className="inline-flex items-center gap-0.5 text-sm font-semibold text-primary hover:underline"
                      >
                        Ver <ChevronRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
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
            <div key={c.id} className="rounded-control border border-line p-3">
              <Link href={`/painel/campanhas/${c.id}`} className="block">
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
              {c.status === "draft" && (
                <button
                  type="button"
                  onClick={() => void deleteDraft(c)}
                  disabled={deletingId === c.id}
                  className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-danger disabled:opacity-50"
                  aria-label={`Excluir rascunho ${c.name}`}
                >
                  <Trash2 className="h-4 w-4" /> {deletingId === c.id ? "Excluindo..." : "Excluir rascunho"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
