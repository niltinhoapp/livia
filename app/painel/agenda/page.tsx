"use client";
// Painel: agenda visual do estabelecimento (visão do dia).
// O dono vê os agendamentos, confirma/conclui/cancela/remarca e cria manual.
//
// MVP: tenant via ?est=<id> (dev). Em produção vem do login (header
// x-establishment-id preenchido pela sessão).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Appointment, AppointmentStatus, ScheduleConfig } from "@/types";

interface Slot { time: string; startAt: number }

const STATUS: Record<AppointmentStatus, { label: string; bg: string; fg: string }> = {
  pending: { label: "Aguardando", bg: "#fef0c7", fg: "#b54708" },
  confirmed: { label: "Confirmado", bg: "#d1fadf", fg: "#027a48" },
  cancelled: { label: "Cancelado", bg: "#f2f4f7", fg: "#667085" },
  completed: { label: "Concluído", bg: "#d1e9ff", fg: "#175cd3" },
  no_show: { label: "Faltou", bg: "#fee4e2", fg: "#b42318" },
};

const btn: React.CSSProperties = {
  background: "#7c3aed", color: "#fff", border: "none", borderRadius: 8,
  padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer",
};
const chip: React.CSSProperties = {
  background: "transparent", border: "1px solid #d0d5dd", borderRadius: 6,
  padding: "5px 10px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#344054",
};
const box: React.CSSProperties = {
  width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid #d0d5dd",
  fontSize: 14, fontFamily: "inherit", boxSizing: "border-box",
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
  const [est, setEst] = useState("");
  const [config, setConfig] = useState<ScheduleConfig | null>(null);
  const [date, setDate] = useState("");
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const offset = config?.utcOffsetMinutes ?? -180;

  const authHeaders = useMemo(
    () => ({ "Content-Type": "application/json", "x-establishment-id": est }),
    [est],
  );

  const loadDay = useCallback(async (id: string, cfg: ScheduleConfig, d: string) => {
    setLoading(true);
    const from = localToEpoch(d, 0, cfg.utcOffsetMinutes);
    const to = from + 24 * 3600000;
    const r = await fetch(`/api/appointments?est=${id}&from=${from}&to=${to}`);
    const j = await r.json();
    setAppts((j.appointments ?? []).sort((a: Appointment, b: Appointment) => a.startAt - b.startAt));
    setLoading(false);
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("est") ?? "";
    setEst(id);
    if (!id) { setLoading(false); return; }
    fetch(`/api/schedule?est=${id}`)
      .then((r) => r.json())
      .then((j) => {
        const cfg: ScheduleConfig = j.schedule;
        setConfig(cfg);
        const d = todayLocal(cfg.utcOffsetMinutes);
        setDate(d);
        return loadDay(id, cfg, d);
      })
      .catch(() => setLoading(false));
  }, [loadDay]);

  const go = (n: number) => {
    if (!config) return;
    const d = addDays(date, n);
    setDate(d);
    setShowNew(false);
    loadDay(est, config, d);
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    await fetch(`/api/appointments/${id}`, { method: "PATCH", headers: authHeaders, body: JSON.stringify(body) });
    if (config) loadDay(est, config, date);
  };

  if (loading && !config) return <Msg>Carregando…</Msg>;
  if (!est) return <Msg>Estabelecimento não informado. Use ?est=&lt;id&gt; na URL.</Msg>;

  const active = appts.filter((a) => a.status !== "cancelled");

  return (
    <main style={{ maxWidth: 760, margin: "32px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button style={chip} onClick={() => go(-1)}>←</button>
          <div style={{ minWidth: 140, textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{date && prettyDate(date)}</div>
            <button style={{ ...chip, border: "none", padding: 0, color: "#7c3aed" }}
              onClick={() => { const d = todayLocal(offset); setDate(d); config && loadDay(est, config, d); }}>
              hoje
            </button>
          </div>
          <button style={chip} onClick={() => go(1)}>→</button>
        </div>
        <button style={btn} onClick={() => setShowNew((v) => !v)}>
          {showNew ? "Fechar" : "+ Novo agendamento"}
        </button>
      </div>

      {showNew && config && (
        <NewAppointment est={est} date={date} config={config} onCreated={() => { setShowNew(false); loadDay(est, config, date); }} />
      )}

      {loading ? (
        <Msg>Carregando…</Msg>
      ) : active.length === 0 ? (
        <div style={{ textAlign: "center", color: "#98a2b3", padding: "48px 0" }}>Nenhum agendamento neste dia.</div>
      ) : (
        active.map((a) => (
          <div key={a.id} style={{ border: "1px solid #e4e7ec", borderRadius: 12, padding: 16, marginBottom: 12, display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div style={{ fontSize: 18, fontWeight: 700, minWidth: 52 }}>{epochToHM(a.startAt, offset)}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{a.serviceName}</div>
              <div style={{ color: "#667085", fontSize: 14 }}>
                {a.contactName ?? "Cliente"} · {a.contactPhone} · {a.durationMin}min
              </div>
              {a.note && <div style={{ color: "#98a2b3", fontSize: 13, marginTop: 2 }}>{a.note}</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                {a.status === "pending" && <button style={chip} onClick={() => patch(a.id, { status: "confirmed" })}>Confirmar</button>}
                {(a.status === "pending" || a.status === "confirmed") && <>
                  <button style={chip} onClick={() => patch(a.id, { status: "completed" })}>Concluir</button>
                  <button style={chip} onClick={() => patch(a.id, { status: "no_show" })}>Faltou</button>
                  <button style={{ ...chip, color: "#b42318", borderColor: "#fda29b" }} onClick={() => patch(a.id, { status: "cancelled" })}>Cancelar</button>
                </>}
              </div>
            </div>
            <span style={{ background: STATUS[a.status].bg, color: STATUS[a.status].fg, borderRadius: 16, padding: "4px 12px", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
              {STATUS[a.status].label}
            </span>
          </div>
        ))
      )}
    </main>
  );
}

function NewAppointment({ est, date, config, onCreated }: {
  est: string; date: string; config: ScheduleConfig; onCreated: () => void;
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
    const r = await fetch(`/api/availability?est=${est}&date=${date}&duration=${duration}`);
    const j = await r.json();
    setSlots(j.slots ?? []);
    setPicked(null);
    setState("idle");
  }, [est, date, duration]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  const create = async () => {
    if (!serviceName || !contactPhone || picked == null) return;
    setState("saving");
    const r = await fetch("/api/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-establishment-id": est },
      body: JSON.stringify({ serviceName, contactName: contactName || null, contactPhone, startAt: picked, durationMin: duration, source: "manual" }),
    });
    if (r.ok) onCreated();
    else setState("error");
  };

  return (
    <div style={{ border: "1px solid #e4e7ec", borderRadius: 12, padding: 16, marginBottom: 16, background: "#faf5ff" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <input style={{ ...box, flex: "1 1 200px" }} value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="Serviço" />
        <input style={{ ...box, flex: "1 1 160px" }} value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Nome do cliente" />
        <input style={{ ...box, flex: "1 1 150px" }} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="WhatsApp (DDD+número)" />
      </div>
      <div style={{ fontSize: 13, color: "#667085", marginBottom: 6 }}>Horários livres em {prettyDate(date)}:</div>
      {state === "loadingSlots" ? (
        <div style={{ color: "#98a2b3" }}>Buscando…</div>
      ) : slots.length === 0 ? (
        <div style={{ color: "#98a2b3" }}>Sem horários livres neste dia.</div>
      ) : (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {slots.map((s) => (
            <button key={s.startAt} onClick={() => setPicked(s.startAt)}
              style={{ ...chip, background: picked === s.startAt ? "#7c3aed" : "transparent", color: picked === s.startAt ? "#fff" : "#344054", borderColor: picked === s.startAt ? "#7c3aed" : "#d0d5dd" }}>
              {s.time}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button style={{ ...btn, opacity: (!serviceName || !contactPhone || picked == null || state === "saving") ? 0.5 : 1 }}
          disabled={!serviceName || !contactPhone || picked == null || state === "saving"} onClick={create}>
          {state === "saving" ? "Salvando…" : "Agendar"}
        </button>
        {state === "error" && <span style={{ color: "#b42318", fontWeight: 600 }}>Erro (horário pode ter sido ocupado).</span>}
      </div>
    </div>
  );
}

function Msg({ children }: { children: React.ReactNode }) {
  return <main style={{ maxWidth: 640, margin: "80px auto", padding: 24, fontFamily: "system-ui, sans-serif", color: "#667085" }}>{children}</main>;
}
