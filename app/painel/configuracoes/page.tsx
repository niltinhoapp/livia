"use client";
// Painel: configurações da Livia (empresa + bot + agenda).
// Reorganizado em abas — os mesmos 3 blocos de sempre (Empresa, Atendente
// virtual, Agenda), só apresentados de forma mais leve. Nenhum campo novo,
// nenhum campo removido, mesmo PUT /api/establishment + PUT /api/schedule.
//
// Tenant vem da sessão (cookie httpOnly criado no login); o painel só é
// renderizado se app/painel/layout.tsx confirmar uma sessão válida.
import { useCallback, useEffect, useState } from "react";
import type { BotConfig, EstablishmentType, ScheduleConfig, DayHours } from "@/types";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select, FieldHelp } from "@/components/ui/Field";
import { Toggle } from "@/components/ui/Toggle";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { ESTABLISHMENT_TYPE_LABELS, WEEKDAY_LABELS } from "@/components/lib/labels";

const TYPES = Object.entries(ESTABLISHMENT_TYPE_LABELS) as [EstablishmentType, string][];

type Tab = "empresa" | "atendente" | "agenda";
const TABS: { key: Tab; label: string }[] = [
  { key: "empresa", label: "Empresa" },
  { key: "atendente", label: "Atendente virtual" },
  { key: "agenda", label: "Agenda" },
];

export default function ConfigPanel() {
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<Tab>("empresa");

  const [name, setName] = useState("");
  const [type, setType] = useState<EstablishmentType>("outro");
  const [bot, setBot] = useState<BotConfig | null>(null);
  const [sched, setSched] = useState<ScheduleConfig | null>(null);

  const load = useCallback(() => {
    setLoadError(false);
    setState("loading");
    Promise.all([fetch("/api/establishment").then((r) => r.json()), fetch("/api/schedule").then((r) => r.json())])
      .then(([e, s]) => {
        setName(e.establishment.name ?? "");
        setType(e.establishment.type ?? "outro");
        setBot(e.establishment.bot);
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
      fetch("/api/establishment", { method: "PUT", headers, body: JSON.stringify({ name, type, bot }) }),
      fetch("/api/schedule", { method: "PUT", headers, body: JSON.stringify(sched) }),
    ]);
    const ok = r1.ok && r2.ok;
    setState(ok ? "saved" : "error");
    if (ok) setTimeout(() => setState("idle"), 2000);
  }, [name, type, bot, sched]);

  if (state === "loading") return <LoadingState />;
  if (loadError || !bot || !sched) return <ErrorState onRetry={load} />;

  const setDay = (k: string, day: DayHours | null) => setSched({ ...sched, days: { ...sched.days, [k]: day } });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Configurações" />

      <div className="mb-5 flex gap-1 rounded-control bg-line/40 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-control px-3 py-2 text-sm font-semibold transition-colors ${
              tab === t.key ? "bg-white text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "empresa" && (
        <Card>
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
        <Card>
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
        <Card>
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
                <div key={k} className="flex flex-wrap items-center gap-3 py-2.5">
                  <label className="flex min-w-[110px] cursor-pointer items-center gap-2">
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
                      <span className="text-xs text-ink-400">pausa</span>
                      <Input type="time" className="w-auto" value={br?.start ?? ""} onChange={(e) => setDay(k, withBreak(day, e.target.value, br?.end ?? ""))} />
                      <span className="text-ink-400">-</span>
                      <Input type="time" className="w-auto" value={br?.end ?? ""} onChange={(e) => setDay(k, withBreak(day, br?.start ?? "", e.target.value))} />
                    </>
                  ) : (
                    <span className="text-sm text-ink-400">Fechado</span>
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

      <div className="mt-5 flex items-center gap-4">
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
