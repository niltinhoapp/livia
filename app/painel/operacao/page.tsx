"use client";
import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/States";
import { StatusBadge } from "@/components/ui/StatusBadge";

type Row = { id: string; name: string; billingStatus: string; whatsappStatus: string; campaigns: number; conversations: number; createdAt: number | null };

export default function OperationsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/operations").then(async (response) => {
      if (!response.ok) throw new Error(response.status === 403 ? "Área restrita ao administrador da plataforma." : "Não foi possível carregar a operação.");
      return response.json();
    }).then((body: { establishments: Row[] }) => setRows(body.establishments)).catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <div className="mx-auto max-w-5xl"><ErrorState /><p className="mt-3 text-center text-sm text-ink-500">{error}</p></div>;
  if (!rows) return <div className="mx-auto max-w-5xl"><p className="text-sm text-ink-500">Carregando operação...</p></div>;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-h1 text-ink-900">Operação da Lívia</h1>
      <p className="mb-6 mt-1 text-sm text-ink-500">Visão administrativa dos 50 estabelecimentos mais recentes.</p>
      <Card>
        <CardTitle>Estabelecimentos</CardTitle>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-ink-400"><tr><th className="py-2">Estabelecimento</th><th>WhatsApp</th><th>Plano</th><th className="text-right">Conversas</th><th className="text-right">Campanhas</th></tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => <tr key={row.id}>
                <td className="py-3 font-semibold text-ink-900">{row.name}</td>
                <td><StatusBadge tone={row.whatsappStatus === "connected" ? "success" : "warning"}>{row.whatsappStatus === "connected" ? "Conectado" : "Desconectado"}</StatusBadge></td>
                <td><StatusBadge tone={row.billingStatus === "active" ? "success" : row.billingStatus === "trial" ? "info" : "neutral"}>{row.billingStatus === "trial" ? "Teste" : row.billingStatus === "active" ? "Ativo" : row.billingStatus}</StatusBadge></td>
                <td className="text-right text-ink-500">{row.conversations}</td><td className="text-right text-ink-500">{row.campaigns}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
