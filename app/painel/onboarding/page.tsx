"use client";
// Onboarding guiado — só para estabelecimento novo (redirecionado aqui pelo
// AppShell quando GET /api/establishment devolve exists:false). Salva de
// forma incremental, um PUT por etapa, reaproveitando exatamente os mesmos
// endpoints/payloads das páginas de Configurações/Conhecimento/WhatsApp —
// nenhum contrato novo, nenhuma etapa obrigatória além do que o backend já
// exige para funcionar.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Building2, CalendarClock, BookOpen, MessageCircle, CheckCircle2 } from "lucide-react";
import type { EstablishmentType, ScheduleConfig, DayHours } from "@/types";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select, Textarea } from "@/components/ui/Field";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { WhatsAppConnectionCard, type WhatsAppPhase } from "@/components/whatsapp/WhatsAppConnectionCard";
import { ESTABLISHMENT_TYPE_LABELS, WEEKDAY_LABELS } from "@/components/lib/labels";

const TYPES = Object.entries(ESTABLISHMENT_TYPE_LABELS) as [EstablishmentType, string][];

type Step = 0 | 1 | 2 | 3 | 4 | 5;
const STEP_LABELS = ["Bem-vindo", "Empresa", "Horários", "Conhecimento", "WhatsApp", "Pronto"];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<EstablishmentType>("outro");
  const [sched, setSched] = useState<ScheduleConfig | null>(null);
  const [about, setAbout] = useState("");
  const [waPhase, setWaPhase] = useState<WhatsAppPhase>("idle");

  const loadSchedule = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    fetch("/api/schedule")
      .then((r) => {
        if (!r.ok) throw new Error("falha ao carregar");
        return r.json();
      })
      .then((j) => setSched(j.schedule))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadSchedule();
  }, [loadSchedule]);

  const hasOpenDay = sched ? Object.values(sched.days).some((d) => d !== null) : false;

  const saveEmpresa = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/establishment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type }),
      });
      if (!res.ok) throw new Error("falha ao salvar");
      setStep(2);
    } catch {
      setSaveError("Não foi possível salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }, [name, type]);

  const saveHorarios = useCallback(async () => {
    if (!sched) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sched),
      });
      if (!res.ok) throw new Error("falha ao salvar");
      setStep(3);
    } catch {
      setSaveError("Não foi possível salvar os horários. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }, [sched]);

  const saveConhecimento = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/knowledge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ about, address: null, hours: null, notes: null, services: [], faqs: [] }),
      });
      if (!res.ok) throw new Error("falha ao salvar");
      setStep(4);
    } catch {
      setSaveError("Não foi possível salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }, [about]);

  const setDay = (k: string, day: DayHours | null) => {
    if (!sched) return;
    setSched({ ...sched, days: { ...sched.days, [k]: day } });
  };

  if (loadError) return <ErrorState onRetry={loadSchedule} />;
  if (loading || !sched) return <LoadingState />;

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center gap-1.5">
        {STEP_LABELS.map((_, i) => (
          <div key={i} className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-primary" : "bg-line"}`} />
        ))}
      </div>

      {step === 0 && (
        <Card className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary">
            <Sparkles className="h-7 w-7" />
          </div>
          <h1 className="mb-2 text-xl font-bold text-ink-900">Bem-vindo(a) à Livia</h1>
          <p className="mb-6 text-sm text-ink-500">
            Vamos configurar rapidinho o essencial para sua atendente virtual começar a funcionar.
          </p>
          <Button className="w-full" onClick={() => setStep(1)}>
            Começar
          </Button>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <StepHeader icon={<Building2 className="h-5 w-5" />} title="Sobre a sua empresa" />
          <div className="space-y-4">
            <div>
              <Label>Nome do negócio</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Clínica Bem Viver" autoFocus />
            </div>
            <div>
              <Label>Segmento</Label>
              <Select value={type} onChange={(e) => setType(e.target.value as EstablishmentType)}>
                {TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <Button className="mt-6 w-full" disabled={!name || saving} onClick={saveEmpresa}>
            {saving ? "Salvando…" : "Continuar"}
          </Button>
          {saveError && <p className="mt-2 text-center text-sm text-danger-fg">{saveError}</p>}
        </Card>
      )}

      {step === 2 && (
        <Card>
          <StepHeader icon={<CalendarClock className="h-5 w-5" />} title="Horários de atendimento" />
          <p className="mb-4 text-sm text-ink-500">Já deixamos um horário comum sugerido — ajuste como preferir.</p>
          <div className="divide-y divide-line">
            {WEEKDAY_LABELS.map(({ key: k, label: dl }) => {
              const day = sched.days[k] ?? null;
              return (
                <div key={k} className="flex flex-wrap items-center gap-3 py-2">
                  <label className="flex min-w-[100px] cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!day}
                      onChange={(e) => setDay(k, e.target.checked ? { open: "09:00", close: "18:00" } : null)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="text-sm font-semibold text-ink-700">{dl}</span>
                  </label>
                  {day ? (
                    <>
                      <Input type="time" className="w-auto" value={day.open} onChange={(e) => setDay(k, { ...day, open: e.target.value })} />
                      <span className="text-ink-400">às</span>
                      <Input type="time" className="w-auto" value={day.close} onChange={(e) => setDay(k, { ...day, close: e.target.value })} />
                    </>
                  ) : (
                    <span className="text-sm text-ink-400">Fechado</span>
                  )}
                </div>
              );
            })}
          </div>
          <Button className="mt-6 w-full" disabled={!hasOpenDay || saving} onClick={saveHorarios}>
            {saving ? "Salvando…" : "Continuar"}
          </Button>
          {!hasOpenDay && <p className="mt-2 text-center text-xs text-ink-400">Abra pelo menos um dia para continuar.</p>}
          {saveError && <p className="mt-2 text-center text-sm text-danger-fg">{saveError}</p>}
        </Card>
      )}

      {step === 3 && (
        <Card>
          <StepHeader icon={<BookOpen className="h-5 w-5" />} title="O que a Livia precisa saber" />
          <Label>Conte um pouco sobre o seu negócio</Label>
          <Textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="Ex.: Clínica de fisioterapia especializada em reabilitação esportiva."
            autoFocus
          />
          <p className="mt-2 text-xs text-ink-400">
            Serviços, preços e perguntas frequentes você pode adicionar depois em "Conhecimento".
          </p>
          <Button className="mt-6 w-full" disabled={!about || saving} onClick={saveConhecimento}>
            {saving ? "Salvando…" : "Continuar"}
          </Button>
          {saveError && <p className="mt-2 text-center text-sm text-danger-fg">{saveError}</p>}
        </Card>
      )}

      {step === 4 && (
        <Card>
          <StepHeader icon={<MessageCircle className="h-5 w-5" />} title="Conectar WhatsApp" />
          <p className="mb-4 text-sm text-ink-500">
            Você pode conectar agora ou fazer isso depois, direto no menu WhatsApp.
          </p>
          <WhatsAppConnectionCard
            phase={waPhase}
            onConnectClick={() => {
              setWaPhase("connecting");
              setTimeout(() => setWaPhase("idle"), 900);
            }}
            onRetry={() => setWaPhase("idle")}
          />
          <div className="mt-6 flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setStep(5)}>
              Conectar depois
            </Button>
            <Button className="flex-1" onClick={() => setStep(5)}>
              Continuar
            </Button>
          </div>
        </Card>
      )}

      {step === 5 && (
        <Card className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success-bg text-success-fg">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <h1 className="mb-2 text-xl font-bold text-ink-900">Tudo pronto!</h1>
          <p className="mb-6 text-sm text-ink-500">Você já pode acompanhar tudo pela Visão geral do painel.</p>
          <Button className="w-full" onClick={() => router.push("/painel")}>
            Ir para o painel
          </Button>
        </Card>
      )}
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
