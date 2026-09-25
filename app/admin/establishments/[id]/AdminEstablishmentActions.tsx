"use client";

import { useState } from "react";
import { actionExtendTrial, actionDisconnectWhatsapp } from "@/app/admin/actions";
import { Unplug, CalendarPlus, Loader2 } from "lucide-react";

interface AdminEstablishmentActionsProps {
  establishmentId: string;
  whatsappStatus?: "connecting" | "connected" | "disconnected";
}

export default function AdminEstablishmentActions({
  establishmentId,
  whatsappStatus,
}: AdminEstablishmentActionsProps) {
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isExtending, setIsExtending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDisconnect = async () => {
    if (!confirm("Isso apagará o WABA ID e Token da Meta atuais. Tem certeza que deseja forçar a desconexão? O cliente terá que refazer o fluxo no painel.")) {
      return;
    }

    try {
      setIsDisconnecting(true);
      setError(null);
      await actionDisconnectWhatsapp(establishmentId);
      alert("WhatsApp desconectado com sucesso.");
    } catch (err: any) {
      setError(err.message || "Erro ao desconectar WhatsApp");
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleExtendTrial = async (days: number) => {
    if (!confirm(`Deseja adicionar ${days} dias de Trial (e reativar a conta se suspensa)?`)) {
      return;
    }

    try {
      setIsExtending(true);
      setError(null);
      await actionExtendTrial(establishmentId, days);
      alert(`${days} dias adicionados ao Trial com sucesso.`);
    } catch (err: any) {
      setError(err.message || "Erro ao estender Trial");
    } finally {
      setIsExtending(false);
    }
  };

  return (
    <div className="mt-8 bg-white border border-slate-200 rounded-lg p-6 shadow-sm w-full">
      <h2 className="text-lg font-semibold text-slate-800 mb-4">Ações de Suporte Nível 1</h2>
      
      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded border border-red-200">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        <button
          onClick={() => handleExtendTrial(7)}
          disabled={isExtending || isDisconnecting}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded shadow-sm disabled:opacity-50 transition-colors"
        >
          {isExtending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />}
          +7 Dias de Trial
        </button>

        <button
          onClick={() => handleExtendTrial(15)}
          disabled={isExtending || isDisconnecting}
          className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded shadow-sm border border-slate-300 disabled:opacity-50 transition-colors"
        >
          {isExtending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />}
          +15 Dias
        </button>

        {whatsappStatus !== "disconnected" && (
          <button
            onClick={handleDisconnect}
            disabled={isExtending || isDisconnecting}
            className="flex items-center gap-2 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 text-sm font-medium rounded shadow-sm border border-red-200 ml-auto disabled:opacity-50 transition-colors"
          >
            {isDisconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unplug className="w-4 h-4" />}
            Forçar Desconexão WhatsApp
          </button>
        )}
      </div>
    </div>
  );
}
