"use client";
import { useEffect, useState } from "react";
// Campanhas — front preparado (OT-FRONT-CAMPANHAS-01). Backend
// (docs/CAMPANHAS.md, CAMPANHAS-02) já define Campaign/CampaignStatus/
// CampaignCounters em @/types, mas ainda não existe nenhuma rota de API —
// esta página fica no estado vazio real até isso existir. Nenhuma chamada é
// feita a um endpoint inexistente; quando a rota existir, trocar o array
// fixo abaixo por um fetch (mesmo padrão de app/painel/clientes/page.tsx).
//
// BACKEND CONTRACT NEEDED: GET /api/campaigns -> { campaigns: Campaign[] }
import Link from "next/link";
import { Megaphone, Send, CheckCheck, Eye, MessageSquareReply, Plus } from "lucide-react";
import type { Campaign } from "@/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/States";
import { CampaignsTable } from "./_components/CampaignsTable";

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  useEffect(() => { fetch("/api/campaigns").then((r) => r.ok ? r.json() : Promise.reject()).then((b: { campaigns?: Campaign[] }) => setCampaigns(b.campaigns ?? [])).catch(() => setCampaigns([])); }, []);

  const totals = campaigns.reduce(
    (acc, c) => ({
      sent: acc.sent + c.counters.sent,
      delivered: acc.delivered + c.counters.delivered,
      read: acc.read + c.counters.read,
      replied: acc.replied + c.counters.replied,
    }),
    { sent: 0, delivered: 0, read: 0, replied: 0 },
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Campanhas"
        description="Crie campanhas pelo WhatsApp e acompanhe os resultados."
        action={
          <div className="flex gap-2">
            <Link href="/painel/campanhas/templates">
              <Button variant="secondary">Templates</Button>
            </Link>
            <Link href="/painel/campanhas/nova">
              <Button>
                <Plus className="h-4 w-4" /> Nova campanha
              </Button>
            </Link>
          </div>
        }
      />

      {/* -------- Resumo -------- */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Campanhas" value={campaigns.length} tone="primary" icon={<Megaphone className="h-5 w-5" />} />
        <StatCard label="Enviados" value={totals.sent} tone="info" icon={<Send className="h-5 w-5" />} />
        <StatCard label="Entregues" value={totals.delivered} tone="info" icon={<CheckCheck className="h-5 w-5" />} />
        <StatCard label="Lidos" value={totals.read} tone="success" icon={<Eye className="h-5 w-5" />} />
        <StatCard
          label="Respostas"
          value={totals.replied}
          tone="success"
          icon={<MessageSquareReply className="h-5 w-5" />}
        />
      </div>

      {/* -------- Listagem -------- */}
      {campaigns.length === 0 ? (
        <EmptyState
          icon={<Megaphone className="h-5 w-5" />}
          title="Nenhuma campanha criada ainda."
          description="Crie sua primeira campanha para enviar mensagens pelo WhatsApp."
          action={
            <Link href="/painel/campanhas/nova">
              <Button size="sm">Criar campanha</Button>
            </Link>
          }
        />
      ) : (
        <CampaignsTable campaigns={campaigns} onDeleted={(id) => setCampaigns((current) => current.filter((campaign) => campaign.id !== id))} />
      )}
    </div>
  );
}
