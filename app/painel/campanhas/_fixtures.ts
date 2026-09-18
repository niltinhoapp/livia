// Fixtures de DEMONSTRAÇÃO VISUAL, exclusivas para desenvolvimento e testes
// de componente (OT-FRONT-CAMPANHAS-01, item 15). NUNCA usadas como default
// real de nenhuma página — todo estado padrão do produto começa vazio
// (GET /api/campaigns ainda não existe — BACKEND CONTRACT NEEDED). Prefixo
// "_" no diretório: Next.js nunca roteia este arquivo.
import type { Campaign, CampaignRecipient } from "@/types";

export const DEMO_CAMPAIGNS: Campaign[] = [
  {
    id: "demo-1",
    establishmentId: "demo",
    name: "Reativação — clientes inativos",
    status: "completed",
    template: { name: "reativacao_30_dias", languageCode: "pt_BR" },
    audience: { eligibleRecipientCount: 128, selectedAt: Date.UTC(2026, 8, 10) },
    scheduledAt: Date.UTC(2026, 8, 12, 9, 0),
    startedAt: Date.UTC(2026, 8, 12, 9, 0),
    finishedAt: Date.UTC(2026, 8, 12, 9, 40),
    counters: { total: 128, queued: 0, sent: 128, delivered: 121, read: 96, failed: 3, replied: 22, skipped: 4 },
    createdAt: Date.UTC(2026, 8, 9),
    updatedAt: Date.UTC(2026, 8, 12, 9, 40),
  },
  {
    id: "demo-2",
    establishmentId: "demo",
    name: "Aviso de feriado",
    status: "scheduled",
    template: { name: "aviso_feriado", languageCode: "pt_BR" },
    audience: { eligibleRecipientCount: 340, selectedAt: Date.UTC(2026, 8, 15) },
    scheduledAt: Date.UTC(2026, 8, 20, 8, 0),
    startedAt: null,
    finishedAt: null,
    counters: { total: 340, queued: 340, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 },
    createdAt: Date.UTC(2026, 8, 15),
    updatedAt: Date.UTC(2026, 8, 15),
  },
  {
    id: "demo-3",
    establishmentId: "demo",
    name: "Lançamento novo serviço",
    status: "draft",
    createdAt: Date.UTC(2026, 8, 16),
    updatedAt: Date.UTC(2026, 8, 16),
    scheduledAt: null,
    startedAt: null,
    finishedAt: null,
    counters: { total: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 },
  },
];

export const DEMO_RECIPIENTS: CampaignRecipient[] = [
  {
    id: "r1",
    establishmentId: "demo",
    campaignId: "demo-1",
    customerPhone: "5511999990001",
    status: "replied",
    sentAt: Date.UTC(2026, 8, 12, 9, 1),
    deliveredAt: Date.UTC(2026, 8, 12, 9, 1, 20),
    readAt: Date.UTC(2026, 8, 12, 9, 5),
    repliedAt: Date.UTC(2026, 8, 12, 9, 12),
  },
  {
    id: "r2",
    establishmentId: "demo",
    campaignId: "demo-1",
    customerPhone: "5511999990002",
    status: "failed",
    sentAt: Date.UTC(2026, 8, 12, 9, 1),
    failedAt: Date.UTC(2026, 8, 12, 9, 1, 5),
    failureReason: "Número inválido",
  },
  {
    id: "r3",
    establishmentId: "demo",
    campaignId: "demo-1",
    customerPhone: "5511999990003",
    status: "read",
    sentAt: Date.UTC(2026, 8, 12, 9, 2),
    deliveredAt: Date.UTC(2026, 8, 12, 9, 2, 10),
    readAt: Date.UTC(2026, 8, 12, 9, 30),
  },
];
