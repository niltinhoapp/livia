"use client";
// Painel: configurações da Livia (bot + agenda).
// Bot: persona, tom, ligar/desligar agendamento, guardrail médico, transferência.
// Agenda: horários por dia, duração, antecedência e template de lembrete.
//
// Tenant vem da sessão (cookie httpOnly criado no login); o painel só é
// renderizado se app/painel/layout.tsx confirmar uma sessão válida.
import { useCallback, useEffect, useState } from "react";
import type { BotConfig, EstablishmentType, ScheduleConfig, DayHours } from "@/types";

const TYPES: { v: EstablishmentType; label: string }[] = [
  { v: "clinica", label: "Clínica" },
  { v: "pet", label: "Pet" },
  { v: "salao", label: "Salão" },
  { v: "estetica", label: "Estética" },
  { v: "odonto", label: "Odonto" },
  { v: "outro", label: "Outro" },
];
const WD = [
  { k: "1", label: "Segunda" }, { k: "2", label: "Terça" }, { k: "3", label: "Quarta" },
  { k: "4", label: "Quinta" }, { k: "5", label: "Sexta" }, { k: "6", label: "Sábado" }, { k: "0", label: "Domingo" },
];

const box: React.CSSProperties = { padding: "9px 11px", borderRadius: 8, border: "1px solid #d0d5dd", fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" };
const card: React.CSSProperties = { border: "1px solid #e4e7ec", borderRadius: 12, padding: 20, marginBottom: 20 };
const label: React.CSSProperties = { fontWeight: 600, fontSize: 14, display: "block", marginBottom: 6 };
const btn: React.CSSProperties = { background: "#7c3aed", color: "#fff", border: "none", borderRadius: 8, padding: "11px 24px", fontSize: 15, fontWeight: 600, cursor: "pointer" };
const h2: React.CSSProperties = { fontSize: 18, margin: "0 0 16px" };

export default function ConfigPanel() {
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [loadError, setLoadError] = useState(false);

  // estabelecimento + bot
  const [name, setName] = useState("");
  const [type, setType] = useState<EstablishmentType>("outro");
  const [bot, setBot] = useState<BotConfig | null>(null);

  // agenda
  const [sched, setSched] = useState<ScheduleConfig | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/establishment").then((r) => r.json()),
      fetch("/api/schedule").then((r) => r.json()),
    ]).then(([e, s]) => {
      setName(e.establishment.name ?? "");
      setType(e.establishment.type ?? "outro");
      setBot(e.establishment.bot);
      setSched(s.schedule);
      setState("idle");
    }).catch(() => { setLoadError(true); setState("idle"); });
  }, []);

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

  if (state === "loading") return <Msg>Carregando…</Msg>;
  if (loadError || !bot || !sched) return <Msg>Erro ao carregar. Faça login novamente.</Msg>;

  const setDay = (k: string, day: DayHours | null) =>
    setSched({ ...sched, days: { ...sched.days, [k]: day } });

  return (
    <main style={{ maxWidth: 720, margin: "36px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 26, marginBottom: 24 }}>Configurações da Livia</h1>

      {/* ---- Estabelecimento ---- */}
      <div style={card}>
        <h2 style={h2}>Estabelecimento</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 260px" }}>
            <label style={label}>Nome do negócio</label>
            <input style={{ ...box, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Clínica Bem Viver" />
          </div>
          <div style={{ flex: "1 1 160px" }}>
            <label style={label}>Segmento</label>
            <select style={{ ...box, width: "100%" }} value={type} onChange={(e) => setType(e.target.value as EstablishmentType)}>
              {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ---- Bot ---- */}
      <div style={card}>
        <h2 style={h2}>Atendente virtual</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div style={{ flex: "1 1 200px" }}>
            <label style={label}>Nome da atendente</label>
            <input style={{ ...box, width: "100%" }} value={bot.personaName} onChange={(e) => setBot({ ...bot, personaName: e.target.value })} placeholder="Livia" />
          </div>
          <div style={{ flex: "1 1 260px" }}>
            <label style={label}>Tom de voz</label>
            <input style={{ ...box, width: "100%" }} value={bot.tone} onChange={(e) => setBot({ ...bot, tone: e.target.value })} placeholder="acolhedora e objetiva" />
          </div>
        </div>

        <Toggle checked={bot.bookingEnabled} onChange={(v) => setBot({ ...bot, bookingEnabled: v })}
          title="Permitir agendamento pela IA"
          desc="A Livia consulta horários livres e marca sozinha na conversa." />
        <Toggle checked={bot.medicalGuardrail} onChange={(v) => setBot({ ...bot, medicalGuardrail: v })}
          title="Trava de saúde (recomendado p/ clínicas)"
          desc="A Livia nunca dá diagnóstico ou orientação médica; sempre encaminha para um profissional." />

        <div style={{ marginTop: 14 }}>
          <label style={label}>Palavras que transferem para um humano</label>
          <input style={{ ...box, width: "100%" }} value={bot.handoffKeywords.join(", ")}
            onChange={(e) => setBot({ ...bot, handoffKeywords: e.target.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) })}
            placeholder="atendente, humano, falar com alguém" />
          <div style={{ fontSize: 12, color: "#98a2b3", marginTop: 4 }}>Separe por vírgula.</div>
        </div>
      </div>

      {/* ---- Agenda ---- */}
      <div style={card}>
        <h2 style={h2}>Agenda</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <div style={{ flex: "1 1 130px" }}>
            <label style={label}>Duração padrão (min)</label>
            <input type="number" style={{ ...box, width: "100%" }} value={sched.defaultDurationMin}
              onChange={(e) => setSched({ ...sched, defaultDurationMin: Number(e.target.value) || 30 })} />
          </div>
          <div style={{ flex: "1 1 130px" }}>
            <label style={label}>Intervalo entre horários (min)</label>
            <input type="number" style={{ ...box, width: "100%" }} value={sched.slotMinutes}
              onChange={(e) => setSched({ ...sched, slotMinutes: Number(e.target.value) || 30 })} />
          </div>
          <div style={{ flex: "1 1 130px" }}>
            <label style={label}>Antecedência mínima (h)</label>
            <input type="number" style={{ ...box, width: "100%" }} value={sched.leadHours}
              onChange={(e) => setSched({ ...sched, leadHours: Number(e.target.value) || 0 })} />
          </div>
        </div>

        <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Horários de funcionamento</div>
        {WD.map(({ k, label: dl }) => {
          const day = sched.days[k] ?? null;
          const br = day?.breaks?.[0];
          return (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0", borderTop: "1px solid #f2f4f7" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 110, cursor: "pointer" }}>
                <input type="checkbox" checked={!!day}
                  onChange={(e) => setDay(k, e.target.checked ? { open: "09:00", close: "18:00" } : null)} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>{dl}</span>
              </label>
              {day ? (
                <>
                  <input type="time" style={box} value={day.open} onChange={(e) => setDay(k, { ...day, open: e.target.value })} />
                  <span style={{ color: "#98a2b3" }}>às</span>
                  <input type="time" style={box} value={day.close} onChange={(e) => setDay(k, { ...day, close: e.target.value })} />
                  <span style={{ color: "#98a2b3", fontSize: 13 }}>pausa</span>
                  <input type="time" style={box} value={br?.start ?? ""} onChange={(e) => setDay(k, withBreak(day, e.target.value, br?.end ?? ""))} />
                  <span style={{ color: "#98a2b3" }}>-</span>
                  <input type="time" style={box} value={br?.end ?? ""} onChange={(e) => setDay(k, withBreak(day, br?.start ?? "", e.target.value))} />
                </>
              ) : (
                <span style={{ color: "#98a2b3", fontSize: 14 }}>Fechado</span>
              )}
            </div>
          );
        })}

        <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <label style={label}>Template do lembrete (Meta)</label>
            <input style={{ ...box, width: "100%" }} value={sched.reminderTemplateName ?? ""}
              onChange={(e) => setSched({ ...sched, reminderTemplateName: e.target.value.trim() || null })}
              placeholder="ex.: lembrete_agendamento" />
            <div style={{ fontSize: 12, color: "#98a2b3", marginTop: 4 }}>Nome de um template aprovado na WABA. Sem ele, o lembrete não é enviado.</div>
          </div>
          <div style={{ flex: "0 1 120px" }}>
            <label style={label}>Idioma</label>
            <input style={{ ...box, width: "100%" }} value={sched.reminderTemplateLang}
              onChange={(e) => setSched({ ...sched, reminderTemplateLang: e.target.value.trim() || "pt_BR" })} />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <button style={{ ...btn, opacity: state === "saving" ? 0.6 : 1 }} disabled={state === "saving"} onClick={save}>
          {state === "saving" ? "Salvando…" : "Salvar configurações"}
        </button>
        {state === "saved" && <span style={{ color: "#12b76a", fontWeight: 600 }}>Salvo!</span>}
        {state === "error" && <span style={{ color: "#d92d20", fontWeight: 600 }}>Erro ao salvar.</span>}
      </div>
    </main>
  );
}

function withBreak(day: DayHours, start: string, end: string): DayHours {
  if (start && end) return { ...day, breaks: [{ start, end }] };
  const { breaks, ...rest } = day;
  void breaks;
  return rest;
}

function Toggle({ checked, onChange, title, desc }: { checked: boolean; onChange: (v: boolean) => void; title: string; desc: string }) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 0", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3, width: 18, height: 18 }} />
      <span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
        <span style={{ display: "block", color: "#667085", fontSize: 13 }}>{desc}</span>
      </span>
    </label>
  );
}

function Msg({ children }: { children: React.ReactNode }) {
  return <main style={{ maxWidth: 640, margin: "80px auto", padding: 24, fontFamily: "system-ui, sans-serif", color: "#667085" }}>{children}</main>;
}
