"use client";
// Painel: configurações da Livia (empresa + bot + agenda).
// Reorganizado em abas — os mesmos 3 blocos de sempre (Empresa, Atendente
// virtual, Agenda), só apresentados de forma mais leve. Nenhum campo novo,
// nenhum campo removido, mesmo PUT /api/establishment + PUT /api/schedule.
//
// Tenant vem da sessão (cookie httpOnly criado no login); o painel só é
// renderizado se app/painel/layout.tsx confirmar uma sessão válida.
import { useCallback, useEffect, useState } from "react";
import type { BotConfig, EstablishmentType, ScheduleConfig, DayHours, DailyOwnerSummaryConfig } from "@/types";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select, FieldHelp } from "@/components/ui/Field";
import { Toggle } from "@/components/ui/Toggle";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { ESTABLISHMENT_TYPE_LABELS, WEEKDAY_LABELS } from "@/components/lib/labels";

const TYPES = Object.entries(ESTABLISHMENT_TYPE_LABELS) as [EstablishmentType, string][];

type Tab = "empresa" | "atendente" | "agenda" | "resumo";
const TABS: { key: Tab; label: string }[] = [
  { key: "empresa", label: "Empresa" },
  { key: "atendente", label: "Atendente virtual" },
  { key: "agenda", label: "Agenda" },\n  { key: "resumo", label: "Resumo diário" },
];

export default function ConfigPanel() {
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<Tab>("empresa");

  const [name, setName] = useState("");
  const [type, setType] = useState<EstablishmentType>("outro");
  const [bot, setBot] = useState<BotConfig | null>(null);
  const [sched, setSched] = useState<ScheduleConfig | null>(null);\n  const [dailySummary, setDailySummary] = useState<DailyOwnerSummaryConfig>({ enabled: false, ownerPhone: "", templateName: "", templateLang: "pt_BR" });

  const load = useCallback(() => {
    setLoadError(false);
    setState("loading");
    Promise.all([fetch("/api/establishment").then((r) => r.json()), fetch("/api/schedule").then((r) => r.json())])
      .then(([e, s]) => {
        setName(e.establishment.name ?? "");
        setType(e.establishment.type ?? "outro");
        setBot(e.establishment.bot);\n        setDailySummary(e.establishment.dailyOwnerSummary ?? { enabled: false, ownerPhone: "", templateName: "", templateLang: "pt_BR" });
        setSched(s.schedule);
        setState("idle");
      })
      .catch(() => {
        setLoadError(true);
        setState("idle");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    if (!bot || !sched) return;
    setState("saving");
    const headers = { "Content-Type": "application/json" };
    const [r1, r2] = await Promise.all([
      fetch("/api/establishment", { method: "PUT", headers, body: JSON.stringify({ name, type, bot, dailyOwnerSummary: dailySummary }) }),
      fetch("/api/schedule", { method: "PUT", headers, body: JSON.stringify(sched) }),
    ]);
    const ok = r1.ok && r2.ok;
    setState(ok ? "saved" : "error");
    if (ok) setTimeout(() => setState("idle"), 2000);
  }, [name, type, bot, sched, dailySummary]);

  if (state === "loading") return <LoadingState />;
  if (loadError || !bot || !sched) return <ErrorState onRetry={load} />;

  const setDay = (k: string, day: DayHours | null) => setSched({ ...sched, days: { ...sched.days, [k]: day } });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Configurações" description="Gerencie os dados do negócio, o comportamento da atendente e as regras da agenda." />

      <SegmentedControl
        className="mb-5 rounded-card border border-line bg-white p-1 shadow-e1"
        items={TABS.map((t) => ({ id: t.key, label: t.label }))}
        value={tab}
        onChange={setTab}
      />

      {tab === "empresa" && (
        <Card className="shadow-e2">
          <div className="mb-5 border-b border-line pb-4"><h2 className="font-semibold text-ink-900">Dados da empresa</h2><p className="mt-1 text-sm text-ink-500">Informações que identificam este estabelecimento dentro da Lívia.</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Nome do negócio</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Clínica Bem Viver" />
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
        </Card>
      )}

      {tab === "atendente" && (
        <Card className="shadow-e2">
          <div className="mb-5 border-b border-line pb-4"><h2 className="font-semibold text-ink-900">Comportamento da atendente</h2><p className="mt-1 text-sm text-ink-500">Defina identidade, automações e situações que exigem atendimento humano.</p></div>
          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Nome da atendente</Label>
              <Input value={bot.personaName} onChange={(e) => setBot({ ...bot, personaName: e.target.value })} placeholder="Livia" />
            </div>
            <div>
              <Label>Tom de voz</Label>
              <Input value={bot.tone} onChange={(e) => setBot({ ...bot, tone: e.target.value })} placeholder="acolhedora e objetiva" />
            </div>
          </div>

          <div className="divide-y divide-line">
              <Toggle
                checked={bot.bookingEnabled}
              onChange={(v) => setBot({ ...bot, bookingEnabled: v })}
              title="Permitir agendamento pela IA"
              desc="A Livia consulta horários livres e marca sozinha na conversa."
            />
            <Toggle
              checked={bot.medicalGuardrail}
              onChange={(v) => setBot({ ...bot, medicalGuardrail: v })}
              title="Trava de saúde (recomendado p/ clínicas)"
              desc="A Livia nunca dá diagnóstico ou orientação médica; sempre encaminha para um profissional."
            />
          </div>

          <div className="mt-4">
            <Label>Palavras que transferem para um humano</Label>
            <Input
              value={bot.handoffKeywords.join(", ")}
              onChange={(e) =>
                setBot({ ...bot, handoffKeywords: e.target.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) })
              }
              placeholder="atendente, humano, falar com alguém"
            />
            <FieldHelp>Separe por vírgula.</FieldHelp>
          </div>
        </Card>
      )}

      {tab === "agenda" && (
        <Card className="shadow-e2">
          <div className="mb-5 border-b border-line pb-4"><h2 className="font-semibold text-ink-900">Regras da agenda</h2><p className="mt-1 text-sm text-ink-500">Configure duração, disponibilidade e lembretes usados nos agendamentos.</p></div>
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            <div>
              <Label>Duração padrão (min)</Label>
              <Input type="number" value={sched.defaultDurationMin} onChange={(e) => setSched({ ...sched, defaultDurationMin: Number(e.target.value) || 30 })} />
            </div>
            <div>
              <Label>Intervalo entre horários (min)</Label>
              <Input type="number" value={sched.slotMinutes} onChange={(e) => setSched({ ...sched, slotMinutes: Number(e.target.value) || 30 })} />
            </div>
            <div>
              <Label>Antecedência mínima (h)</Label>
              <Input type="number" value={sched.leadHours} onChange={(e) => setSched({ ...sched, leadHours: Number(e.target.value) || 0 })} />
            </div>
          </div>

          <p className="mb-2 text-sm font-semibold text-ink-700">Horários de funcionamento</p>
          <div className="divide-y divide-line">
            {WEEKDAY_LABELS.map(({ key: k, label: dl }) => {
              const day = sched.days[k] ?? null;
              const br = day?.breaks?.[0];
              return (
                <div key={k} className="py-3">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!day}
                    onChange={(e) => setDay(k, e.target.checked ? { open: "09:00", close: "18:00" } : null)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="text-sm font-semibold text-ink-700">{dl}</span>
                </label>
                {day ? (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 pl-6">
                    <div className="flex items-center gap-2">
                      <Input type="time" className="w-auto" value={day.open} onChange={(e) => setDay(k, { ...day, open: e.target.value })} />
                      <span className="text-ink-400">às</span>
                      <Input type="time" className="w-auto" value={day.close} onChange={(e) => setDay(k, { ...day, close: e.target.value })} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-400">pausa</span>
                      <Input type="time" className="w-auto" value={br?.start ?? ""} onChange={(e) => setDay(k, withBreak(day, e.target.value, br?.end ?? ""))} />
                      <span className="text-ink-400">-</span>
                      <Input type="time" className="w-auto" value={br?.end ?? ""} onChange={(e) => setDay(k, withBreak(day, br?.start ?? "", e.target.value))} />
                    </div>
                  </div>
                ) : (
                  <span className="mt-1 block pl-6 text-sm text-ink-400">Fechado</span>
                )}
              </div>
              );
            })}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <Label>Template do lembrete (Meta)</Label>
              <Input
                value={sched.reminderTemplateName ?? ""}
                onChange={(e) => setSched({ ...sched, reminderTemplateName: e.target.value.trim() || null })}
                placeholder="ex.: lembrete_agendamento"
              />
              <Toggle
                checked={Boolean(bot.ordersEnabled)}
                onChange={(v) => setBot({ ...bot, ordersEnabled: v })}
                title="Permitir pedidos pela IA"
                desc="A Lívia consulta o cardápio e monta pedidos com valores calculados no servidor."
              />
              <FieldHelp>Nome de um template aprovado na WABA. Sem ele, o lembrete não é enviado.</FieldHelp>
            </div>
            <div>
              <Label>Idioma</Label>
              <Input
                className="w-28"
                value={sched.reminderTemplateLang}
                onChange={(e) => setSched({ ...sched, reminderTemplateLang: e.target.value.trim() || "pt_BR" })}
              />
            </div>
          </div>
        </Card>
      )}

      {tab === "resumo" && (
        <Card className="shadow-e2">
          <div className="mb-5 border-b border-line pb-4"><h2 className="font-semibold text-ink-900">Resumo diário no WhatsApp</h2><p className="mt-1 text-sm text-ink-500">Ao fim do expediente, a Lívia envia ao proprietário uma prestação de contas do dia.</p></div>
          <Toggle checked={dailySummary.enabled} onChange={(v) => setDailySummary({ ...dailySummary, enabled: v })} title="Enviar resumo diário" desc="O envio acontece depois do horário de fechamento configurado na agenda." />
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div><Label>WhatsApp do proprietário</Label><Input inputMode="tel" value={dailySummary.ownerPhone} onChange={(e) => setDailySummary({ ...dailySummary, ownerPhone: e.target.value })} placeholder="5511999999999" /><FieldHelp>Use DDI + DDD + número.</FieldHelp></div>
            <div><Label>Template aprovado na Meta</Label><Input value={dailySummary.templateName} onChange={(e) => setDailySummary({ ...dailySummary, templateName: e.target.value })} placeholder="resumo_diario_livia" /><FieldHelp>Necessário para o envio proativo.</FieldHelp></div>
            <div><Label>Idioma do template</Label><Input value={dailySummary.templateLang} onChange={(e) => setDailySummary({ ...dailySummary, templateLang: e.target.value })} placeholder="pt_BR" /></div>
          </div>
          <div className="mt-5 rounded-control border border-primary/20 bg-primary-light/10 p-4"><p className="text-sm font-semibold text-ink-900">O que o proprietário recebe</p><p className="mt-1 text-xs leading-relaxed text-ink-500">Atendimentos do dia, agendamentos realizados, oportunidades encontradas e conversas que precisam de atenção.</p></div>
        </Card>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-4 rounded-card border border-line bg-white/95 p-3 shadow-e2 lg:sticky lg:bottom-3 lg:z-10 lg:backdrop-blur"><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-ink-900">Alterações nas configurações</p><p className="text-xs text-ink-500">Salve para aplicar as mudanças ao funcionamento da Lívia.</p></div>
        <Button disabled={state === "saving"} onClick={save}>
          {state === "saving" ? "Salvando…" : "Salvar configurações"}
        </Button>
        {state === "saved" && <span className="text-sm font-semibold text-success-fg">Salvo!</span>}
        {state === "error" && <span className="text-sm font-semibold text-danger-fg">Erro ao salvar.</span>}
      </div>
    </div>
  );
}

function withBreak(day: DayHours, start: string, end: string): DayHours {
  if (start && end) return { ...day, breaks: [{ start, end }] };
  const { breaks, ...rest } = day;
  void breaks;
  return rest;
}
