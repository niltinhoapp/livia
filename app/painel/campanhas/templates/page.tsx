"use client";
// Templates de mensagem — estrutura preparada (OT-FRONT-CAMPANHAS-01).
// O domínio real (types/index.ts) só define CampaignTemplateSnapshot
// {name, languageCode} — um retrato mínimo usado dentro de Campaign, não um
// cadastro completo de template (categoria/status/corpo da mensagem). Não
// existe integração com a Meta nesta OT (nem API, nem template real).
//
// BACKEND CONTRACT NEEDED:
//   - GET /api/campaigns/templates -> { templates: Template[] }
//     Template { id, name, category, languageCode, status, previewBody }
//     status: "approved" | "in_review" | "rejected" (só "approved" é
//     selecionável em Nova Campanha)
import Link from "next/link";
import { ArrowLeft, FileText } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";

export default function CampaignTemplatesPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/painel/campanhas"
        className="mb-4 inline-flex items-center gap-1 text-xs font-semibold text-ink-400 hover:text-primary"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Voltar para Campanhas
      </Link>

      <PageHeader
        title="Templates"
        description="Templates aprovados pela Meta ficam disponíveis aqui para usar em campanhas."
      />

      {/* Estado real: sem integração com a Meta ainda, a lista fica vazia. */}
      <EmptyState
        icon={<FileText className="h-5 w-5" />}
        title="Nenhum template disponível ainda"
        description="Conecte-se à Meta para importar seus templates aprovados. Enquanto isso, a criação de campanhas fica indisponível."
      />
    </div>
  );
}
