"use client";
import Link from "next/link";
import { ArrowLeft, Megaphone } from "lucide-react";
import { useState } from "react";
import type { Campaign, CampaignRecipient } from "@/types";
import { Card, CardTitle } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/States";
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_RECIPIENT_STATUS_LABEL } from "@/components/lib/labels";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

function formatDateTime(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toLocaleString("pt-BR");
}

export function CampaignDetail({ campaign, recipients }: { campaign: Campaign | null; recipients: CampaignRecipient[] }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendLocked, setSendLocked] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  if (!campaign) {
    return (
      <div className="mx-auto max-w-4xl">
        <BackLink />
        <EmptyState
          icon={<Megaphone className="h-5 w-5" />}
          title="Campanha não encontrada"
          description="Ela pode ter sido removida ou não pertencer a este estabelecimento."
        />
      </div>
    );
  }

  const status = CAMPAIGN_STATUS_LABEL[campaign.status];
  const campaignId = campaign.id;
  const canSendNow = campaign.status === "draft" && !!campaign.audience && !!campaign.template && recipients.length > 0;

  async function confirmSend() {
    if (sending || sendLocked) return;
    setSendLocked(true);
    setSending(true);
    setActivationError(null);
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Não foi possível ativar a campanha.");
      }
      window.location.reload();
    } catch (error) {
      setActivationError(error instanceof Error ? error.message : "Não foi possível ativar a campanha.");
      setSending(false);
      setSendLocked(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-ink-900">{campaign.name}</h1>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </div>
          <p className="mt-1 text-sm text-ink-500">{formatDateTime(campaign.scheduledAt ?? campaign.createdAt)}</p>
        </div>
        {canSendNow ? <Button onClick={() => setConfirmOpen(true)}>Enviar agora</Button> : null}
      </div>

      {activationError ? <p role="alert" className="mb-4 rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-fg">{activationError}</p> : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Enviados" value={campaign.counters.sent} tone="info" />
        <StatCard label="Entregues" value={campaign.counters.delivered} tone="info" />
        <StatCard label="Lidos" value={campaign.counters.read} tone="success" />
        <StatCard label="Respostas" value={campaign.counters.replied} tone="success" />
        <StatCard label="Falhas" value={campaign.counters.failed} tone="danger" />
      </div>

      <CardTitle>Destinatários</CardTitle>
      {recipients.length === 0 ? (
        <EmptyState title="Nenhum destinatário ainda" description="Aparecem aqui assim que o envio começar." />
      ) : (
        <RecipientsTable recipients={recipients} />
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Confirmar envio"
        description={`Campanha “${campaign.name}”, template “${campaign.template?.name ?? "—"}”, para ${recipients.length} contatos. As mensagens serão enviadas pelo WhatsApp. Confirme que esta audiência possui consentimento válido.`}
        confirmLabel="Confirmar envio"
        confirmDisabled={sending}
        onConfirm={confirmSend}
        onCancel={() => { if (!sending) setConfirmOpen(false); }}
      />
    </div>
  );
}

function RecipientsTable({ recipients }: { recipients: CampaignRecipient[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-control border border-line sm:block">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-ink-400">
            <tr>
              <th className="px-4 py-2.5">Contato</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Enviado</th>
              <th className="px-4 py-2.5">Entregue</th>
              <th className="px-4 py-2.5">Lido</th>
              <th className="px-4 py-2.5">Respondeu</th>
              <th className="px-4 py-2.5 text-right">Ação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {recipients.map((r) => {
              const status = CAMPAIGN_RECIPIENT_STATUS_LABEL[r.status];
              return (
                <tr key={r.id}>
                  <td className="px-4 py-3 font-medium text-ink-900">{r.customerPhone}</td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </td>
                  <td className="px-4 py-3 text-ink-500">{formatDateTime(r.sentAt ?? null)}</td>
                  <td className="px-4 py-3 text-ink-500">{formatDateTime(r.deliveredAt ?? null)}</td>
                  <td className="px-4 py-3 text-ink-500">{formatDateTime(r.readAt ?? null)}</td>
                  <td className="px-4 py-3 text-ink-500">{formatDateTime(r.repliedAt ?? null)}</td>
                  <td className="px-4 py-3 text-right">
                    {/* BACKEND CONTRACT NEEDED: vínculo campaignRecipient -> conversationId */}
                    <span className="text-xs text-ink-300" title="Disponível quando o vínculo com a conversa existir">
                      Ver conversa
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="space-y-2 sm:hidden">
        {recipients.map((r) => {
          const status = CAMPAIGN_RECIPIENT_STATUS_LABEL[r.status];
          return (
            <div key={r.id} className="rounded-control border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-ink-900">{r.customerPhone}</p>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </div>
              <p className="mt-1 text-xs text-ink-400">Enviado {formatDateTime(r.sentAt ?? null)}</p>
            </div>
          );
        })}
      </div>
    </>
  );
}

function BackLink() {
  return (
    <Link
      href="/painel/campanhas"
      className="mb-4 inline-flex items-center gap-1 text-xs font-semibold text-ink-400 hover:text-primary"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> Voltar para Campanhas
    </Link>
  );
}

export default CampaignDetail;
