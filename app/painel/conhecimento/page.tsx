"use client";
// Painel: base de conhecimento do estabelecimento.
// É aqui que o dono ensina a Livia — serviços, horários, endereço e FAQs.
// A IA responde SOMENTE com o que estiver cadastrado aqui.
//
// MVP: o estabelecimento é passado por ?est=<id> (dev). Em produção virá do
// login e o header x-establishment-id é preenchido pela sessão.
import { useCallback, useEffect, useState } from "react";
import type { KnowledgeService, KnowledgeFaq } from "@/types";

type SaveState = "idle" | "loading" | "saving" | "saved" | "error";

const box: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #d0d5dd",
  fontSize: 15,
  fontFamily: "inherit",
  boxSizing: "border-box",
};
const label: React.CSSProperties = { fontWeight: 600, fontSize: 14, display: "block", marginBottom: 6 };
const card: React.CSSProperties = { border: "1px solid #e4e7ec", borderRadius: 12, padding: 16, marginBottom: 16 };
const btn: React.CSSProperties = {
  background: "#7c3aed", color: "#fff", border: "none", borderRadius: 8,
  padding: "10px 20px", fontSize: 15, fontWeight: 600, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  background: "transparent", color: "#7c3aed", border: "1px dashed #b794f6",
  borderRadius: 8, padding: "8px 14px", fontSize: 14, fontWeight: 600, cursor: "pointer",
};

export default function KnowledgePanel() {
  const [est, setEst] = useState<string>("");
  const [state, setState] = useState<SaveState>("loading");
  const [about, setAbout] = useState("");
  const [address, setAddress] = useState("");
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");
  const [services, setServices] = useState<KnowledgeService[]>([]);
  const [faqs, setFaqs] = useState<KnowledgeFaq[]>([]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("est") ?? "";
    setEst(id);
    if (!id) { setState("error"); return; }
    fetch(`/api/knowledge?est=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => {
        const kb = d.knowledge;
        if (kb) {
          setAbout(kb.about ?? "");
          setAddress(kb.address ?? "");
          setHours(kb.hours ?? "");
          setNotes(kb.notes ?? "");
          setServices(kb.services ?? []);
          setFaqs(kb.faqs ?? []);
        }
        setState("idle");
      })
      .catch(() => setState("error"));
  }, []);

  const save = useCallback(async () => {
    setState("saving");
    const res = await fetch("/api/knowledge", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-establishment-id": est },
      body: JSON.stringify({ about, address, hours, notes, services, faqs }),
    });
    setState(res.ok ? "saved" : "error");
    if (res.ok) setTimeout(() => setState("idle"), 2000);
  }, [est, about, address, hours, notes, services, faqs]);

  if (state === "loading") return <Msg>Carregando…</Msg>;
  if (!est) return <Msg>Estabelecimento não informado. Use ?est=&lt;id&gt; na URL.</Msg>;

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>O que a Livia precisa saber</h1>
      <p style={{ color: "#667085", marginTop: 0, marginBottom: 24 }}>
        Quanto mais completo, melhor ela atende. A Livia só responde com base no que estiver aqui.
      </p>

      <div style={card}>
        <label style={label}>Sobre o negócio</label>
        <textarea style={{ ...box, minHeight: 70 }} value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder="Ex.: Clínica de fisioterapia especializada em reabilitação esportiva." />
      </div>

      <div style={{ ...card, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px" }}>
          <label style={label}>Endereço</label>
          <input style={box} value={address} onChange={(e) => setAddress(e.target.value)}
            placeholder="Rua, número, bairro, cidade" />
        </div>
        <div style={{ flex: "1 1 220px" }}>
          <label style={label}>Horário de funcionamento</label>
          <input style={box} value={hours} onChange={(e) => setHours(e.target.value)}
            placeholder="Seg-Sex 9h-18h, Sáb 9h-13h" />
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <strong>Serviços</strong>
          <button style={btnGhost} onClick={() => setServices([...services, { name: "", priceText: null, durationText: null, description: null }])}>+ Adicionar serviço</button>
        </div>
        {services.length === 0 && <p style={{ color: "#98a2b3", margin: 0 }}>Nenhum serviço ainda.</p>}
        {services.map((s, i) => (
          <div key={i} style={{ borderTop: i ? "1px solid #f2f4f7" : "none", paddingTop: i ? 12 : 0, marginTop: i ? 12 : 0 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input style={{ ...box, flex: "1 1 200px" }} value={s.name}
                onChange={(e) => upd(services, setServices, i, { name: e.target.value })} placeholder="Nome do serviço" />
              <input style={{ ...box, flex: "1 1 120px" }} value={s.priceText ?? ""}
                onChange={(e) => upd(services, setServices, i, { priceText: e.target.value })} placeholder="Preço (ex.: a partir de R$ 80)" />
              <input style={{ ...box, flex: "1 1 100px" }} value={s.durationText ?? ""}
                onChange={(e) => upd(services, setServices, i, { durationText: e.target.value })} placeholder="Duração" />
            </div>
            <input style={{ ...box, marginTop: 8 }} value={s.description ?? ""}
              onChange={(e) => upd(services, setServices, i, { description: e.target.value })} placeholder="Descrição (opcional)" />
            <button style={{ ...btnGhost, color: "#d92d20", borderColor: "#fda29b", marginTop: 8 }}
              onClick={() => setServices(services.filter((_, x) => x !== i))}>Remover</button>
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <strong>Perguntas frequentes</strong>
          <button style={btnGhost} onClick={() => setFaqs([...faqs, { question: "", answer: "" }])}>+ Adicionar pergunta</button>
        </div>
        {faqs.length === 0 && <p style={{ color: "#98a2b3", margin: 0 }}>Nenhuma pergunta ainda.</p>}
        {faqs.map((f, i) => (
          <div key={i} style={{ borderTop: i ? "1px solid #f2f4f7" : "none", paddingTop: i ? 12 : 0, marginTop: i ? 12 : 0 }}>
            <input style={box} value={f.question}
              onChange={(e) => upd(faqs, setFaqs, i, { question: e.target.value })} placeholder="Pergunta (ex.: Vocês atendem convênio?)" />
            <textarea style={{ ...box, marginTop: 8, minHeight: 56 }} value={f.answer}
              onChange={(e) => upd(faqs, setFaqs, i, { answer: e.target.value })} placeholder="Resposta" />
            <button style={{ ...btnGhost, color: "#d92d20", borderColor: "#fda29b", marginTop: 8 }}
              onClick={() => setFaqs(faqs.filter((_, x) => x !== i))}>Remover</button>
          </div>
        ))}
      </div>

      <div style={card}>
        <label style={label}>Observações (pagamento, convênios, políticas…)</label>
        <textarea style={{ ...box, minHeight: 70 }} value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Ex.: Aceitamos Pix e cartão. Convênios: Unimed, Bradesco Saúde." />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <button style={{ ...btn, opacity: state === "saving" ? 0.6 : 1 }} disabled={state === "saving"} onClick={save}>
          {state === "saving" ? "Salvando…" : "Salvar"}
        </button>
        {state === "saved" && <span style={{ color: "#12b76a", fontWeight: 600 }}>Salvo!</span>}
        {state === "error" && <span style={{ color: "#d92d20", fontWeight: 600 }}>Erro ao salvar.</span>}
      </div>
    </main>
  );
}

function upd<T>(arr: T[], setArr: (v: T[]) => void, i: number, patch: Partial<T>) {
  setArr(arr.map((item, x) => (x === i ? { ...item, ...patch } : item)));
}

function Msg({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 640, margin: "80px auto", padding: 24, fontFamily: "system-ui, sans-serif", color: "#667085" }}>
      {children}
    </main>
  );
}
