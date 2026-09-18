"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileText } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { TemplatesTable } from "./_components/TemplatesTable";
import type { Template } from "./_types";

function normalizeTemplate(raw: Record<string, unknown>): Template | null {
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.language !== "string" || typeof raw.status !== "string") return null;
  const components = Array.isArray(raw.components) ? raw.components.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
  const body = components.find((item) => String(item.type).toUpperCase() === "BODY");
  const status = raw.status.toUpperCase() === "APPROVED" ? "approved" : raw.status.toUpperCase() === "PENDING" ? "pending" : raw.status.toUpperCase() === "REJECTED" ? "rejected" : "other";
  return { id: raw.id, name: raw.name, category: typeof raw.category === "string" ? raw.category : "—", languageCode: raw.language, status, previewBody: typeof body?.text === "string" ? body.text : "Prévia indisponível", components, senderCompatible: raw.senderCompatible === true };
}

export default function CampaignTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    fetch("/api/campaigns/templates")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("template request failed")))
      .then((body: { templates?: unknown[] }) => setTemplates((body.templates ?? []).flatMap((item) => item && typeof item === "object" ? [normalizeTemplate(item as Record<string, unknown>)].filter((value): value is Template => value !== null) : [])))
      .catch(() => setTemplates([]))
      .finally(() => setLoaded(true));
  }, []);
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

      {loaded && templates.length > 0 ? <TemplatesTable templates={templates} /> : <EmptyState icon={<FileText className="h-5 w-5" />} title="Nenhum template disponível ainda" description={loaded ? "Conecte-se à Meta para importar seus templates aprovados." : "Carregando templates…"} />}
    </div>
  );
}
