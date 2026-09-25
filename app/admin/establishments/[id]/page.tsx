import { getAdminEstablishmentDetail } from "@/lib/repo.admin";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Building2, CreditCard, MessageCircle, BarChart3 } from "lucide-react";
import AdminEstablishmentActions from "./AdminEstablishmentActions";

export default async function AdminEstablishmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const est = await getAdminEstablishmentDetail(id);

  if (!est) {
    notFound();
  }

  const createdAtFormatted = est.createdAt
    ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(new Date(est.createdAt))
    : "Desconhecido";

  const trialEndsFormatted = est.trialEndsAt
    ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(est.trialEndsAt))
    : null;

  return (
    <div className="flex flex-col items-start h-full max-w-5xl mx-auto">
      <Link
        href="/admin/establishments"
        className="flex items-center text-sm font-medium text-slate-500 hover:text-slate-800 mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        Voltar para lista
      </Link>

      <div className="flex items-center justify-between w-full mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">{est.name || "Sem Nome"}</h1>
          <p className="mt-1 text-slate-500">ID: <span className="font-mono text-xs">{est.id}</span></p>
        </div>
        {est.status === "active" ? (
          <span className="px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
            Conta Ativa
          </span>
        ) : (
          <span className="px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800">
            Conta Suspensa
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full">
        {/* Empresa */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <Building2 className="h-5 w-5 text-slate-400 mr-2" />
            <h2 className="text-lg font-semibold text-slate-800">Informações do Negócio</h2>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Segmento/Tipo:</span>
              <span className="font-medium text-slate-900 capitalize">{est.type}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Dono (UID):</span>
              <span className="font-medium font-mono text-xs text-slate-900">{est.ownerUid}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Data de Cadastro:</span>
              <span className="font-medium text-slate-900">{createdAtFormatted}</span>
            </div>
          </div>
        </div>

        {/* Cobrança */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <CreditCard className="h-5 w-5 text-slate-400 mr-2" />
            <h2 className="text-lg font-semibold text-slate-800">Plano e Assinatura</h2>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Status Financeiro:</span>
              <span className="font-medium text-slate-900 capitalize">{est.billingStatus || "N/A"}</span>
            </div>
            {est.billingStatus === "trial" && trialEndsFormatted && (
              <div className="flex justify-between">
                <span className="text-slate-500">Fim do Período de Teste:</span>
                <span className="font-medium text-blue-600">{trialEndsFormatted}</span>
              </div>
            )}
          </div>
        </div>

        {/* WhatsApp */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <MessageCircle className="h-5 w-5 text-slate-400 mr-2" />
            <h2 className="text-lg font-semibold text-slate-800">Conexão WhatsApp</h2>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Status Meta:</span>
              <span className="font-medium text-slate-900 capitalize">{est.whatsappStatus || "Desconectado"}</span>
            </div>
            {est.whatsappStatus === "connected" && (
              <>
                <div className="flex justify-between">
                  <span className="text-slate-500">Phone Number ID (Meta):</span>
                  <span className="font-medium font-mono text-xs text-slate-900">{est.whatsappPhoneNumberId || "N/A"}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Recursos */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center mb-4">
            <BarChart3 className="h-5 w-5 text-slate-400 mr-2" />
            <h2 className="text-lg font-semibold text-slate-800">Uso de Recursos (Geral)</h2>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Total de Conversas:</span>
              <span className="font-medium text-slate-900">{est.metrics.conversations}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Total de Campanhas (Criadas):</span>
              <span className="font-medium text-slate-900">{est.metrics.campaigns}</span>
            </div>
          </div>
        </div>
      </div>
      
      <AdminEstablishmentActions 
        establishmentId={est.id} 
        whatsappStatus={est.whatsappStatus} 
      />

      <div className="mt-8 p-4 bg-amber-50 border border-amber-200 rounded-lg w-full">
        <p className="text-sm text-amber-800">
          <strong>Segurança Admin:</strong> Credenciais nativas (Meta/Asaas) não são expostas nesta interface.
          As ações executam em servidor validando seus privilégios administrativos rigorosamente.
        </p>
      </div>
    </div>
  );
}
