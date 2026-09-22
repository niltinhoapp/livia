"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import type { Campaign } from "@/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";
import { CAMPAIGN_STATUS_LABEL } from "@/components/lib/labels";

function formatDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toLocaleDateString("pt-BR");
}

export function CampaignsTable({
  campaigns,
  onDeleted,
}: {
  campaigns: Campaign[];
  onDeleted?: (id: string) => void;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function executeDelete(campaign: Campaign) {
    if (campaign.status !== "draft" || deletingId) return;
    setDeletingId(campaign.id);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setErrorMessage(body.error ?? "Não foi possível excluir o rascunho.");
        return;
      }
      onDeleted?.(campaign.id);
    } catch {
      setErrorMessage("Não foi possível excluir o rascunho.");
    } finally {
      setDeletingId(null);
      setDeleteTarget(null);
    }
  }

  return (
    <>
      {errorMessage && (
        <div className="mb-4 rounded-control border border-danger/30 bg-danger-bg/40 p-3 text-sm text-danger-fg">
          {errorMessage}
        </div>
      )}

      {/* Desktop: tabela com componente padronizado */}
      <div className="hidden sm:block">
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campanha</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Público</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Enviados</TableHead>
                <TableHead className="text-right">Entregues</TableHead>
                <TableHead className="text-right">Lidos</TableHead>
                <TableHead className="text-right">Respostas</TableHead>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((c) => {
                const status = CAMPAIGN_STATUS_LABEL[c.status];
                return (
                  <TableRow key={c.id}>
                    <TableCell className="font-semibold text-ink-900">
                      <Link
                        href={`/painel/campanhas/${c.id}`}
                        className="inline-flex items-center gap-1.5 text-ink-900 transition-colors hover:text-primary"
                      >
                        {c.name}
                        <ChevronRight className="h-3.5 w-3.5 text-ink-400" />
                      </Link>
                    </TableCell>
                    <TableCell className="text-ink-600">{c.template?.name ?? "—"}</TableCell>
                    <TableCell className="text-ink-600">
                      {c.audience ? `${c.audience.eligibleRecipientCount} contatos` : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right font-medium text-ink-900">{c.counters.sent}</TableCell>
                    <TableCell className="text-right font-medium text-ink-900">{c.counters.delivered}</TableCell>
                    <TableCell className="text-right font-medium text-ink-900">{c.counters.read}</TableCell>
                    <TableCell className="text-right font-medium text-ink-900">{c.counters.replied}</TableCell>
                    <TableCell className="whitespace-nowrap text-ink-500">
                      {formatDate(c.scheduledAt ?? c.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.status === "draft" ? (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(c)}
                          disabled={deletingId === c.id}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-danger transition-colors hover:underline disabled:opacity-50"
                          aria-label={`Excluir rascunho ${c.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {deletingId === c.id ? "Excluindo..." : "Excluir"}
                        </button>
                      ) : (
                        <span className="text-xs text-ink-400">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </div>

      {/* Mobile: cartões empilhados */}
      <div className="space-y-3 sm:hidden">
        {campaigns.map((c) => {
          const status = CAMPAIGN_STATUS_LABEL[c.status];
          return (
            <div key={c.id} className="rounded-card border border-line bg-white p-4 shadow-e1">
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
                  onClick={() => setDeleteTarget(c)}
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

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Excluir rascunho de campanha?"
        description={
          deleteTarget
            ? `Tem certeza que deseja excluir o rascunho "${deleteTarget.name}"? Esta ação não poderá ser desfeita.`
            : undefined
        }
        confirmLabel={deletingId ? "Excluindo..." : "Confirmar exclusão"}
        cancelLabel="Cancelar"
        danger
        confirmDisabled={Boolean(deletingId)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            void executeDelete(deleteTarget);
          }
        }}
      />
    </>
  );
}
