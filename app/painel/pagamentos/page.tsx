"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCard, Link2, Unplug } from "lucide-react";

type Connection = { status: "pending" | "connected" | "requires_reauth" | "disconnected" | "error"; providerAccountId: string | null; connectedAt: number | null };

export default function PaymentsPage() {
  const [connection, setConnection] = useState<Connection | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const load = useCallback(async () => { const response = await fetch("/api/payments/connections/mercado-pago"); const body = await response.json(); setConnection(body.connection); setLoading(false); }, []);
  useEffect(() => { void load(); }, [load]);
  async function connect() { setError(""); const response = await fetch("/api/payments/connections/mercado-pago", { method: "POST" }); const body = await response.json(); if (!response.ok || !body.authorizationUrl) { setError("Não foi possível iniciar a conexão."); return; } window.location.assign(body.authorizationUrl); }
  async function disconnect() { setError(""); const response = await fetch("/api/payments/connections/mercado-pago", { method: "DELETE" }); if (!response.ok) { setError("Não foi possível desconectar agora."); return; } await load(); }
  const connected = connection?.status === "connected";
  return <div className="mx-auto max-w-3xl space-y-6"><div><p className="text-sm font-semibold text-primary">Recebimentos</p><h1 className="mt-1 text-2xl font-bold text-ink-900">Conexões de pagamento</h1><p className="mt-2 text-sm text-ink-500">Conecte a conta do seu negócio. Os recebimentos continuam pertencendo ao estabelecimento.</p></div><section className="rounded-card border border-line bg-white p-6 shadow-e1"><div className="flex items-start justify-between gap-4"><div className="flex gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-control bg-primary-50 text-primary"><CreditCard className="h-5 w-5" /></span><div><h2 className="font-semibold text-ink-900">Mercado Pago</h2><p className="mt-1 text-sm text-ink-500">{loading ? "Consultando conexão…" : connected ? "Mercado Pago conectado" : connection?.status === "requires_reauth" ? "Reconexão necessária" : "Nenhuma conta conectada"}</p>{connected && connection?.providerAccountId ? <p className="mt-1 text-xs text-ink-400">Conta #{connection.providerAccountId}</p> : null}</div></div>{connected ? <button onClick={() => void disconnect()} className="inline-flex items-center gap-2 rounded-control border border-line px-3 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"><Unplug className="h-4 w-4" />Desconectar</button> : <button onClick={() => void connect()} disabled={loading} className="inline-flex items-center gap-2 rounded-control bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50"><Link2 className="h-4 w-4" />{connection ? "Reconectar" : "Conectar Mercado Pago"}</button>}</div>{error ? <p className="mt-4 text-sm text-danger">{error}</p> : null}</section><p className="text-xs text-ink-400">Nenhuma cobrança ou checkout é criado nesta etapa.</p></div>;
}
