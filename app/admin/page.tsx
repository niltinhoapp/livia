import { getAdminDashboardMetrics } from "@/lib/repo.admin";
import { Store, Activity, CalendarDays, MessageCircle } from "lucide-react";

export default async function AdminPage() {
  const metrics = await getAdminDashboardMetrics();

  return (
    <div className="flex flex-col items-start h-full max-w-5xl">
      <h1 className="text-3xl font-bold text-slate-900">Dashboard</h1>
      <p className="mt-2 text-slate-500">Visão geral da operação da Lívia</p>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mt-8 w-full">
        {/* Card 1 */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-500">Total de Estabelecimentos</h3>
            <Store className="h-5 w-5 text-slate-400" />
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-2">{metrics.totalEstablishments}</p>
        </div>

        {/* Card 2 */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-500">Estabelecimentos Ativos</h3>
            <Activity className="h-5 w-5 text-green-500" />
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-2">{metrics.activeEstablishments}</p>
        </div>

        {/* Card 3 */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-500">Em Período de Teste</h3>
            <CalendarDays className="h-5 w-5 text-blue-500" />
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-2">{metrics.trialEstablishments}</p>
        </div>

        {/* Card 4 */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-500">WhatsApp Conectado</h3>
            <MessageCircle className="h-5 w-5 text-emerald-500" />
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-2">{metrics.whatsappConnected}</p>
        </div>
      </div>
    </div>
  );
}
