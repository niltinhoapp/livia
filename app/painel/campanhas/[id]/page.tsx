"use client";
// Detalhe de campanha — estrutura preparada (OT-FRONT-CAMPANHAS-01).
// Sem GET /api/campaigns/:id ainda, a página sempre mostra "não encontrada"
// (estado real — nenhuma campanha existe de fato hoje). A estrutura de
// cabeçalho/resumo/destinatários já fica pronta para plugar o fetch depois.
//
// BACKEND CONTRACT NEEDED:
//   - GET /api/campaigns/:id -> { campaign: Campaign }
//   - GET /api/campaigns/:id/recipients -> { recipients: CampaignRecipient[] }
import Link from "next/link";
import { ArrowLeft, Megaphone } from "lucide-react";
import type { Campaign, CampaignRecipient } from "@/types";
import { Card, CardTitle } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/States";
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_RECIPIENT_STATUS_LABEL } from "@/components/lib/labels";

function formatDateTime(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toLocaleString("pt-BR");
}

export function CampaignDetail({ campaign, recipients }: { campaign: Campaign | null; recipients: CampaignRecipient[] }) {
  if (!campaign) {
    return (
      <div className="mx-auto max-w-4xl">
        <BackLink />
        <EmptyState
          icon={<Megaphone className="h-5 w-5" />}
          title="Campanha não encontrada"
          description="Ela pode ter sido removida, ou o backend de campanhas ainda não está conectado."
        />
      </div>
    );
  }

  const status = CAMPAIGN_STATUS_LABEL[campaign.status];

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
      </div>

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

// `params` segue a convenção async de Next.js 15 (mesmo formato das demais
// rotas dinâmicas do projeto), mas ainda não é lido: sem GET /api/campaigns/:id,
// não há por onde buscar pelo id. Quando o contrato existir, resolver
// `params` (await/use conforme a versão de React em uso) e disparar o fetch.
export default function CampaignDetailPage({ params: _params }: { params: Promise<{ id: string }> }) {
  return <CampaignDetail campaign={null} recipients={[]} />;
}
