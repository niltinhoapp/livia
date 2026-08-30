"use client";
// Painel: agenda visual do estabelecimento (visão do dia).
// O dono vê os agendamentos, confirma/conclui/cancela/remarca e cria manual.
//
// Tenant vem da sessão (cookie httpOnly criado no login); o painel só é
// renderizado se app/painel/layout.tsx confirmar uma sessão válida.
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import type { Appointment, AppointmentStatus, ScheduleConfig } from "@/types";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { PageHeader } from "@/components/ui/PageHeader";

interface Slot {
  time: string;
  startAt: number;
}

const STATUS: Record<AppointmentStatus, { label: string; tone: StatusTone }> = {
  pending: { label: "Aguardando", tone: "warning" },
  confirmed: { label: "Confirmado", tone: "success" },
  cancelled: { label: "Cancelado", tone: "neutral" },
  completed: { label: "Concluído", tone: "info" },
  no_show: { label: "Faltou", tone: "danger" },
};

// epoch/data helpers (mesmo offset fixo do backend).
function localToEpoch(dateStr: string, localMinutes: number, offsetMin: number): number {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const wall = Date.UTC(y!, mo! - 1, d!, 0, 0) + localMinutes * 60000;
  return wall - offsetMin * 60000;
}
function epochToHM(epoch: number, offsetMin: number): string {
  const dt = new Date(epoch + offsetMin * 60000);
  return `${String(dt.getUTCHours()).padStart(2, "0")}:${String(dt.getUTCMinutes()).padStart(2, "0")}`;
}
function addDays(dateStr: string, n: number): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, mo! - 1, d! + n));
  return dt.toISOString().slice(0, 10);
}
function todayLocal(offsetMin: number): string {
  return new Date(Date.now() + offsetMin * 60000).toISOString().slice(0, 10);
}
function prettyDate(dateStr: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, mo! - 1, d!));
  const wd = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][dt.getUTCDay()];
  return `${wd} ${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}`;
}

export default function AgendaPanel() {
  const [config, setConfig] = useState<ScheduleConfig | null>(null);
  const [date, setDate] = useState("");
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState(false);

  const offset = config?.utcOffsetMinutes ?? -180;

  const loadDay = useCallback(async (cfg: ScheduleConfig, d: string) => {
    setLoading(true);
    const from = localToEpoch(d, 0, cfg.utcOffsetMinutes);
    const to = from + 24 * 3600000;
    const r = await fetch(`/api/appointments?from=${from}&to=${to}`);
    const j = await r.json();
    setAppts((j.appointments ?? []).sort((a: Appointment, b: Appointment) => a.startAt - b.startAt));
    setLoading(false);
  }, []);

  const loadAll = useCallback(() => {
    setError(false);
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((j) => {
        const cfg: ScheduleConfig = j.schedule;
        setConfig(cfg);
        const d = todayLocal(cfg.utcOffsetMinutes);
        setDate(d);
        return loadDay(cfg, d);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, [loadDay]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const go = (n: number) => {
    if (!config) return;
    const d = addDays(date, n);
    setDate(d);
    setShowNew(false);
    loadDay(config, d);
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    await fetch(`/api/appointments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (config) loadDay(config, date);
  };

  if (error) return <ErrorState onRetry={loadAll} />;
  if (loading && !config) return <LoadingState />;
  if (!config) return null;

  const active = appts.filter((a) => a.status !== "cancelled");

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Agenda"
        action={
          <Button size="sm" onClick={() => setShowNew((v) => !v)}>
            {showNew ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {showNew ? "Fechar" : "Novo agendamento"}
          </Button>
        }
      />

      <div className="mb-5 flex items-center gap-3">
        <button
          onClick={() => go(-1)}
          className="rounded-control border border-line p-2 text-ink-500 hover:bg-line/30"
          aria-label="Dia anterior"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="min-w-[140px] text-center">
          <p className="text-lg font-bold text-ink-900">{date && prettyDate(date)}</p>
          <button
            className="text-xs font-semibold text-primary hover:underline"
            onClick={() => {
              const d = todayLocal(offset);
              setDate(d);
              loadDay(config, d);
            }}
          >
            hoje
          </button>
        </div>
        <button
          onClick={() => go(1)}
          className="rounded-control border border-line p-2 text-ink-500 hover:bg-line/30"
          aria-label="Próximo dia"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {showNew && (
        <NewAppointment
          date={date}
          config={config}
          onCreated={() => {
            setShowNew(false);
            loadDay(config, date);
          }}
        />
      )}

      {loading ? (
        <LoadingState />
      ) : active.length === 0 ? (
        <EmptyState title="Nenhum agendamento neste dia" description="Os agendamentos feitos pela Livia ou por você aparecem aqui." />
      ) : (
        <div className="space-y-3">
          {active.map((a) => (
            <Card key={a.id} className="flex items-start gap-4 p-4">
              <div className="min-w-[52px] text-lg font-bold text-ink-900">{epochToHM(a.startAt, offset)}</div>
              <div className="flex-1">
                <p className="font-semibold text-ink-900">{a.serviceName}</p>
                <p className="text-sm text-ink-500">
                  {a.contactName ?? "Cliente"} · {a.contactPhone} · {a.durationMin}min
                </p>
                {a.note && <p className="mt-1 text-xs text-ink-400">{a.note}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {a.status === "pending" && (
                    <Button size="sm" variant="secondary" onClick={() => patch(a.id, { status: "confirmed" })}>
                      Confirmar
                    </Button>
                  )}
                  {(a.status === "pending" || a.status === "confirmed") && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => patch(a.id, { status: "completed" })}>
                        Concluir
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => patch(a.id, { status: "no_show" })}>
                        Faltou
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => patch(a.id, { status: "cancelled" })}>
                        Cancelar
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <StatusBadge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</StatusBadge>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function NewAppointment({
  date,
  config,
  onCreated,
}: {
  date: string;
  config: ScheduleConfig;
  onCreated: () => void;
}) {
  const [serviceName, setServiceName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [duration, setDuration] = useState(config.defaultDurationMin);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "loadingSlots" | "saving" | "error">("idle");

  const loadSlots = useCallback(async () => {
    setState("loadingSlots");
    const r = await fetch(`/api/availability?date=${date}&duration=${duration}`);
    const j = await r.json();
    setSlots(j.slots ?? []);
    setPicked(null);
    setState("idle");
  }, [date, duration]);

  useEffect(() => {
    loadSlots();
  }, [loadSlots]);

  const create = async () => {
    if (!serviceName || !contactPhone || picked == null) return;
    setState("saving");
    const r = await fetch("/api/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceName,
        contactName: contactName || null,
        contactPhone,
        startAt: picked,
        durationMin: duration,
        source: "manual",
      }),
    });
    if (r.ok) onCreated();
    else setState("error");
  };

  return (
    <Card className="mb-5 bg-primary-light/40">
      <div className="mb-3 flex flex-wrap gap-3">
        <Input className="flex-1 basis-[200px]" value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="Serviço" />
        <Input className="flex-1 basis-[160px]" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Nome do cliente" />
        <Input className="flex-1 basis-[150px]" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="WhatsApp (DDD+número)" />
      </div>
      <p className="mb-2 text-sm text-ink-500">Horários livres em {prettyDate(date)}:</p>
      {state === "loadingSlots" ? (
        <p className="text-sm text-ink-400">Buscando…</p>
      ) : slots.length === 0 ? (
        <p className="text-sm text-ink-400">Sem horários livres neste dia.</p>
      ) : (
        <div className="mb-3 flex flex-wrap gap-2">
          {slots.map((s) => (
            <button
              key={s.startAt}
              onClick={() => setPicked(s.startAt)}
              className={`rounded-control border px-3 py-1.5 text-sm font-semibold ${
                picked === s.startAt ? "border-primary bg-primary text-white" : "border-line text-ink-700 hover:bg-line/30"
              }`}
            >
              {s.time}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button disabled={!serviceName || !contactPhone || picked == null || state === "saving"} onClick={create}>
          {state === "saving" ? "Salvando…" : "Agendar"}
        </Button>
        {state === "error" && <span className="text-sm font-semibold text-danger-fg">Erro (horário pode ter sido ocupado).</span>}
      </div>
    </Card>
  );
}
