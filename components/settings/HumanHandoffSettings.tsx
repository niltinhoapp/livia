"use client";
// Aviso de atendimento humano: quem recebe e por onde (push, WhatsApp ou os
// dois). Salva à parte porque o template de WhatsApp é validado na Meta.
import { useCallback, useEffect, useState } from "react";
import type { HumanHandoffNotificationConfig } from "@/types";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select, FieldHelp } from "@/components/ui/Field";
import { Toggle } from "@/components/ui/Toggle";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { disableHandoffPush, enableHandoffPush, pushConfigured, pushEnabledHere, pushSupported } from "@/lib/push/enableHandoffPush";

type TemplateOption = { name: string; language: string; paramCount: number; body: string };

const PUSH_ERRORS: Record<string, string> = {
  unsupported: "Este navegador não recebe avisos. No iPhone, adicione o painel à Tela de Início e abra por lá.",
  not_configured: "Os avisos por push ainda não estão disponíveis nesta instalação.",
  denied: "A permissão de notificações foi negada. Libere nas configurações do navegador.",
  failed: "Não foi possível ativar os avisos agora. Tente novamente.",
};

export function HumanHandoffSettings() {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [push, setPush] = useState(false);
  const [whatsapp, setWhatsapp] = useState(false);
  const [responsiblePhone, setResponsiblePhone] = useState("");
  const [template, setTemplate] = useState("");
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [pushDevices, setPushDevices] = useState(0);
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templatesError, setTemplatesError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [thisDevice, setThisDevice] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const load = useCallback(() => {
    setLoadState("loading");
    fetch("/api/human-handoff/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j: { config: HumanHandoffNotificationConfig | null; pushDevices: number; whatsappConnected: boolean }) => {
        setPush(Boolean(j.config?.push));
        setWhatsapp(Boolean(j.config?.whatsapp));
        setResponsiblePhone(j.config?.responsiblePhone ?? "");
        setTemplate(j.config?.templateName ? `${j.config.templateName}|${j.config.templateLang}` : "");
        setPushDevices(j.pushDevices);
        setWhatsappConnected(j.whatsappConnected);
        setThisDevice(pushEnabledHere());
        setLoadState("ready");
      })
      .catch(() => setLoadState("error"));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!whatsapp || !whatsappConnected || templates !== null) return;
    fetch("/api/human-handoff/templates")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("templates"))))
      .then((j: { templates: TemplateOption[] }) => setTemplates(j.templates))
      .catch(() => setTemplatesError(true));
  }, [whatsapp, whatsappConnected, templates]);

  async function save() {
    setSaving(true);
    setMessage(null);
    const [templateName, templateLang] = template.split("|");
    const res = await fetch("/api/human-handoff/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ push, whatsapp, responsiblePhone, templateName: templateName ?? "", templateLang: templateLang ?? "" }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    setSaving(false);
    setMessage(res?.ok ? { tone: "ok", text: "Avisos salvos." } : { tone: "error", text: body.error ?? "Não foi possível salvar." });
  }

  async function togglePushHere() {
    setPushBusy(true);
    setMessage(null);
    if (thisDevice) {
      await disableHandoffPush();
      setThisDevice(false);
      setPushDevices((n) => Math.max(0, n - 1));
    } else {
      const result = await enableHandoffPush();
      if (result.ok) {
        setThisDevice(true);
        setPushDevices((n) => n + 1);
        setMessage({ tone: "ok", text: "Este aparelho vai receber os avisos." });
      } else {
        setMessage({ tone: "error", text: PUSH_ERRORS[result.reason] });
      }
    }
    setPushBusy(false);
  }

  if (loadState === "loading") return <LoadingState />;
  if (loadState === "error") return <ErrorState onRetry={load} />;

  return (
    <Card className="shadow-e2">
      <div className="mb-5 border-b border-line pb-4">
        <h2 className="font-semibold text-ink-900">Atendimento humano</h2>
        <p className="mt-1 text-sm text-ink-500">Quando um cliente pede para falar com uma pessoa, a Lívia para de responder e avisa o responsável.</p>
      </div>

      <div className="rounded-control border border-info/30 bg-info-bg/30 p-4 text-sm text-info-fg">
        Quando você assumir um atendimento, as próximas mensagens desse cliente continuarão com você até que escolha <strong>“Devolver para Lívia”</strong>. A Lívia nunca retoma sozinha, nem depois de horas ou dias.
      </div>

      <div className="mt-5 space-y-4">
        <Toggle checked={push} onChange={setPush} title="Avisar por push" desc="Notificação no celular ou computador em que você ativar os avisos. Tocar abre a conversa." />
        {push && (
          <div className="rounded-control border border-line p-4">
            <p className="text-sm text-ink-700">{pushDevices === 0 ? "Nenhum aparelho recebe avisos ainda." : `${pushDevices} aparelho(s) recebendo avisos.`}</p>
            {pushSupported() && pushConfigured() ? (
              <Button className="mt-3" size="sm" variant="secondary" disabled={pushBusy} onClick={togglePushHere}>
                {thisDevice ? "Parar avisos neste aparelho" : "Ativar avisos neste aparelho"}
              </Button>
            ) : (
              <FieldHelp>{pushConfigured() ? PUSH_ERRORS.unsupported : PUSH_ERRORS.not_configured}</FieldHelp>
            )}
            <FieldHelp>O push depende do navegador e da permissão do aparelho; pode atrasar ou não chegar. A conversa sempre aparece como pendente em Conversas.</FieldHelp>
          </div>
        )}

        <Toggle checked={whatsapp} onChange={setWhatsapp} title="Avisar por WhatsApp" desc="Uma mensagem para o WhatsApp do responsável, enviada pelo número do estabelecimento. Uma vez por pedido de atendimento." />
        {whatsapp && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>WhatsApp do responsável</Label>
              <Input inputMode="tel" value={responsiblePhone} onChange={(e) => setResponsiblePhone(e.target.value)} placeholder="5511999999999" />
              <FieldHelp>Use DDI + DDD + número.</FieldHelp>
            </div>
            <div>
              <Label>Template aprovado</Label>
              {!whatsappConnected ? (
                <FieldHelp>Conecte o WhatsApp do estabelecimento para escolher um template.</FieldHelp>
              ) : templatesError ? (
                <FieldHelp>Não foi possível consultar seus templates na Meta agora.</FieldHelp>
              ) : templates === null ? (
                <FieldHelp>Carregando templates…</FieldHelp>
              ) : templates.length === 0 ? (
                <FieldHelp>Nenhum template aprovado compatível. Crie na Meta um template de Utilidade com no máximo duas variáveis: {"{{1}}"} cliente e {"{{2}}"} link da conversa.</FieldHelp>
              ) : (
                <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
                  <option value="">Escolha um template</option>
                  {templates.map((t) => (
                    <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language})</option>
                  ))}
                </Select>
              )}
              <FieldHelp>Fora da janela de 24h a Meta só entrega mensagens por template aprovado. Variáveis: {"{{1}}"} nome/telefone do cliente, {"{{2}}"} link da conversa.</FieldHelp>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button disabled={saving} onClick={save}>{saving ? "Salvando…" : "Salvar avisos"}</Button>
        {message && <span className={`text-sm font-semibold ${message.tone === "ok" ? "text-success-fg" : "text-danger-fg"}`}>{message.text}</span>}
      </div>
    </Card>
  );
}
