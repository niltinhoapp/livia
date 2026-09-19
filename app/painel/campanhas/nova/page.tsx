"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Megaphone, Users, FileText, ClipboardCheck, Check, ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Step = 0 | 1 | 2 | 3;
const STEP_LABELS = ["Campanha", "Público", "Template", "Revisão"];

type Audience = "all" | "imported" | "segment";
type CampaignTemplate = { id: string; name: string; language: string; status: string; components: Record<string, unknown>[]; senderCompatible: boolean; campaignCompatible: boolean };
type AudiencePreview = { selected: number; eligible: number; excluded: number };

export default function NewCampaignPage() {
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<Audience>("all");
  const [templateId, setTemplateId] = useState("");
  const [templates, setTemplates] = useState<CampaignTemplate[]>([]);
  const [audiencePreview, setAudiencePreview] = useState<AudiencePreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([
      fetch("/api/campaigns/templates").then((r) => r.ok ? r.json() : Promise.reject()),
      fetch("/api/campaigns/audience").then((r) => r.ok ? r.json() : Promise.reject()),
    ]).then(([templateBody, audienceBody]: [{ templates?: CampaignTemplate[] }, { audience?: AudiencePreview }]) => {
      setTemplates(templateBody.templates ?? []);
      setAudiencePreview(audienceBody.audience ?? null);
    }).catch(() => setError("Não foi possível carregar os dados necessários para a campanha."));
  }, []);
  const selectedTemplate = templates.find((template) => template.id === templateId);

  const canContinueStep0 = name.trim().length > 0;
  const canSendNow = Boolean(selectedTemplate && audience === "all" && (audiencePreview?.eligible ?? 0) > 0 && !saving);

  async function createAndPrepare(sendNow: boolean) {
    if (!selectedTemplate) return;
    setSaving(true);
    setError(null);
    try {
      const createResponse = await fetch("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const created = await createResponse.json() as { campaign?: { id: string }; error?: string };
      if (!createResponse.ok || !created.campaign) throw new Error(created.error ?? "Não foi possível criar a campanha.");
      const audienceResponse = await fetch(`/api/campaigns/${encodeURIComponent(created.campaign.id)}/audience`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection: "all_eligible", template: { id: selectedTemplate.id, name: selectedTemplate.name, languageCode: selectedTemplate.language } }),
      });
      const audienceBody = await audienceResponse.json().catch(() => ({})) as { error?: string };
      if (!audienceResponse.ok) throw new Error(audienceBody.error ?? "Não foi possível preparar os destinatários.");
      if (sendNow) {
        const sendResponse = await fetch(`/api/campaigns/${encodeURIComponent(created.campaign.id)}/send`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
        });
        const sendBody = await sendResponse.json().catch(() => ({})) as { error?: string };
        if (!sendResponse.ok) throw new Error(sendBody.error ?? "Não foi possível iniciar o envio.");
      }
      window.location.href = `/painel/campanhas/${created.campaign.id}`;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a campanha.");
      setSaving(false);
    }
  }

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
        {error ? <p role="alert" className="mb-4 rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-fg">{error}</p> : null}
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

            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              <div className="rounded-control border border-line p-3">
                <p className="text-lg font-bold text-ink-900">{audiencePreview?.selected ?? "—"}</p>
                <p className="text-xs text-ink-400">selecionados</p>
              </div>
              <div className="rounded-control border border-line p-3">
                <p className="text-lg font-bold text-ink-900">{audiencePreview?.excluded ?? "—"}</p>
                <p className="text-xs text-ink-400">inelegíveis</p>
              </div>
              <div className="rounded-control border border-line p-3">
                <p className="text-lg font-bold text-ink-900">{audiencePreview?.eligible ?? "—"}</p>
                <p className="text-xs text-ink-400">elegíveis</p>
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
              {templates.filter((template) => template.campaignCompatible).map((template) => <option key={template.id} value={template.id}>{template.name} · {template.language}</option>)}
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
              <ReviewRow label="Template" value={selectedTemplate ? `${selectedTemplate.name} · ${selectedTemplate.language}` : "—"} />
              <ReviewRow label="Destinatários" value={audiencePreview ? String(audiencePreview.eligible) : "—"} />
            </div>
            <p className="mt-5 rounded-control border border-warning/30 bg-warning-bg/30 p-3 text-xs text-warning-fg">As mensagens serão enviadas pelo WhatsApp somente após sua confirmação explícita. Confirme que esta audiência possui consentimento válido.</p>

            <div className="mt-6 flex gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setStep(2)}>
                Voltar
              </Button>
              <Button className="flex-1" disabled={!canSendNow} onClick={() => setConfirmOpen(true)}>
                Enviar agora
              </Button>
              <Button variant="secondary" className="flex-1" disabled title="Agendamento será habilitado em Campanhas-06">
                Agendar
              </Button>
              <Button variant="secondary" className="flex-1" disabled={saving || !selectedTemplate} onClick={() => void createAndPrepare(false)}>
                {saving ? "Preparando…" : "Salvar e preparar"}
              </Button>
            </div>
          </Card>
        )}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Confirmar envio"
        description={`Campanha “${name}”, template “${selectedTemplate?.name ?? "—"}”, para ${audiencePreview?.eligible ?? 0} destinatários. As mensagens serão enviadas pelo WhatsApp. Confirme que esta audiência possui consentimento válido.`}
        confirmLabel="Confirmar envio"
        confirmDisabled={!canSendNow}
        onConfirm={() => { setConfirmOpen(false); void createAndPrepare(true); }}
        onCancel={() => { if (!saving) setConfirmOpen(false); }}
      />
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
