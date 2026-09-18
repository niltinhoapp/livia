"use client";
// Nova campanha — fluxo visual preparado (OT-FRONT-CAMPANHAS-01), mesmo
// padrão de stepper de app/painel/onboarding/page.tsx. Nenhum passo chama
// backend: não existe ainda POST /api/campaigns nem endpoint de audiência
// elegível/templates aprovados — os campos ficam prontos para receber esses
// contratos depois, sem redesenhar nada.
//
// BACKEND CONTRACT NEEDED:
//   - GET /api/campaigns/audience-count?segment=... -> { eligible, ineligible, optedOut }
//   - GET /api/campaigns/templates -> { templates: Template[] } (status "approved" apenas selecionável)
//   - POST /api/campaigns -> cria em draft/scheduled
import { useState } from "react";
import { useEffect } from "react";
import Link from "next/link";
import { Megaphone, Users, FileText, ClipboardCheck, Check, ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusBadge } from "@/components/ui/StatusBadge";

type Step = 0 | 1 | 2 | 3;
const STEP_LABELS = ["Campanha", "Público", "Template", "Revisão"];

type Audience = "all" | "imported" | "segment";

export default function NewCampaignPage() {
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<Audience>("all");
  const [templateId, setTemplateId] = useState("");
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; language: string; status: string; components: Record<string, unknown>[]; senderCompatible: boolean }>>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => { fetch("/api/campaigns/templates").then((r) => r.ok ? r.json() : Promise.reject()).then((b: { templates?: typeof templates }) => setTemplates(b.templates ?? [])).catch(() => setTemplates([])); }, []);
  const selectedTemplate = templates.find((template) => template.id === templateId);

  const canContinueStep0 = name.trim().length > 0;

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/painel/campanhas"
        className="mb-4 inline-flex items-center gap-1 text-xs font-semibold text-ink-400 hover:text-primary"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Voltar para Campanhas
      </Link>

      <ol className="mb-6 flex items-center gap-2">
        {STEP_LABELS.map((label, i) => {
          const done = i < step;
          const current = i === step;
          return (
            <li key={i} className="flex flex-1 items-center gap-2">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-150 ${
                  done
                    ? "bg-primary text-white"
                    : current
                      ? "bg-primary-light text-primary ring-2 ring-primary/30"
                      : "bg-ink-100 text-ink-400"
                }`}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={`hidden truncate text-xs font-medium sm:block ${current ? "text-ink-900" : "text-ink-400"}`}>
                {label}
              </span>
              {i < STEP_LABELS.length - 1 && (
                <span className={`h-0.5 flex-1 rounded-full transition-colors duration-150 ${done ? "bg-primary" : "bg-line"}`} />
              )}
            </li>
          );
        })}
      </ol>

      <div key={step} className="animate-fade-in">
        {step === 0 && (
          <Card>
            <StepHeader icon={<Megaphone className="h-5 w-5" />} title="Campanha" />
            <Label>Nome da campanha</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Reativação de clientes inativos"
              autoFocus
            />
            <p className="mt-1.5 text-xs text-ink-400">Só para você identificar depois — o cliente nunca vê esse nome.</p>
            <Button className="mt-6 w-full" disabled={!canContinueStep0} onClick={() => setStep(1)}>
              Continuar
            </Button>
          </Card>
        )}

        {step === 1 && (
          <Card>
            <StepHeader icon={<Users className="h-5 w-5" />} title="Público" />
            <Label>Audiência</Label>
            <SegmentedControl<Audience>
              value={audience}
              onChange={setAudience}
              items={[
                { id: "all", label: "Todos elegíveis" },
                { id: "imported", label: "Importados" },
                { id: "segment", label: "Segmentação" },
              ]}
              className="mb-1"
            />
            {audience !== "all" && (
              <p className="mb-3 text-xs text-ink-400">
                {audience === "imported" ? "Importação de contatos" : "Segmentações"} chega em breve — por enquanto,
                disponível só para todos os contatos elegíveis.
              </p>
            )}

            {/* BACKEND CONTRACT NEEDED: contagem real de elegíveis/inelegíveis/opt-out */}
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              <div className="rounded-control border border-line p-3">
                <p className="text-lg font-bold text-ink-900">—</p>
                <p className="text-xs text-ink-400">selecionados</p>
              </div>
              <div className="rounded-control border border-line p-3">
                <p className="text-lg font-bold text-ink-900">—</p>
                <p className="text-xs text-ink-400">inelegíveis</p>
              </div>
              <div className="rounded-control border border-line p-3">
                <p className="text-lg font-bold text-ink-900">—</p>
                <p className="text-xs text-ink-400">opt-out</p>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setStep(0)}>
                Voltar
              </Button>
              <Button className="flex-1" disabled={audience !== "all"} onClick={() => setStep(2)}>
                Continuar
              </Button>
            </div>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <StepHeader icon={<FileText className="h-5 w-5" />} title="Template" />
            <Label>Template aprovado</Label>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Selecione um template</option>
              {templates.filter((template) => template.status === "APPROVED" && template.senderCompatible).map((template) => <option key={template.id} value={template.id}>{template.name} · {template.language}</option>)}
            </Select>
            <p className="mt-1.5 text-xs text-ink-400">
              Templates devem estar aprovados e compatíveis com o sender —{" "}
              <Link href="/painel/campanhas/templates" className="font-semibold text-primary hover:underline">
                ver Templates
              </Link>
              .
            </p>

            <div className="mt-4 rounded-control border border-dashed border-line p-4 text-center text-sm text-ink-400">
              {selectedTemplate ? "Template aprovado e compatível selecionado." : "Prévia da mensagem aparece aqui quando um template for selecionado."}
            </div>

            <div className="mt-6 flex gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setStep(1)}>
                Voltar
              </Button>
              <Button className="flex-1" disabled={!selectedTemplate} onClick={() => setStep(3)} title="Selecione um template para continuar">
                Continuar
              </Button>
            </div>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <StepHeader icon={<ClipboardCheck className="h-5 w-5" />} title="Revisão" />
            <div className="space-y-3 text-sm">
              <ReviewRow label="Campanha" value={name || "—"} />
              <ReviewRow label="Público" value="Todos os contatos elegíveis" />
              <ReviewRow label="Template" value={templateId || "—"} />
              <ReviewRow label="Destinatários" value="—" />
            </div>

            <div className="mt-5 rounded-control border border-warning/30 bg-warning-bg/30 p-3 text-xs text-warning-fg">
              O envio real ainda depende do backend de Campanhas (<StatusBadge tone="warning">em construção</StatusBadge>).
            </div>

            <div className="mt-6 flex gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setStep(2)}>
                Voltar
              </Button>
              <Button className="flex-1" disabled title="Envio será habilitado em Campanhas-06">
                Enviar agora
              </Button>
              <Button variant="secondary" className="flex-1" disabled title="Agendamento será habilitado em Campanhas-06">
                Agendar
              </Button>
              <Button variant="secondary" className="flex-1" disabled={saving || !selectedTemplate} onClick={async () => { setSaving(true); try { const created = await fetch("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => r.json()); await fetch(`/api/campaigns/${created.campaign.id}/audience`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selection: "all_eligible", template: { id: selectedTemplate!.id, name: selectedTemplate!.name, languageCode: selectedTemplate!.language, status: selectedTemplate!.status, components: selectedTemplate!.components, senderCompatible: selectedTemplate!.senderCompatible } }) }); window.location.href = `/painel/campanhas/${created.campaign.id}`; } finally { setSaving(false); } }}>
                {saving ? "Preparando…" : "Salvar e preparar"}
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function StepHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-light text-primary">{icon}</div>
      <h2 className="text-lg font-bold text-ink-900">{title}</h2>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line/60 pb-2">
      <span className="text-ink-400">{label}</span>
      <span className="font-medium text-ink-900">{value}</span>
    </div>
  );
}
