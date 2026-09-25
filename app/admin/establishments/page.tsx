import { listAdminEstablishments } from "@/lib/repo.admin";
import Link from "next/link";

export default async function AdminEstablishmentsPage() {
  const establishments = await listAdminEstablishments();

  return (
    <div className="flex flex-col items-start h-full max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold text-slate-900">Estabelecimentos</h1>
      <p className="mt-2 text-slate-500">Gestão dos clientes cadastrados</p>

      <div className="w-full mt-8 bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th className="px-6 py-4 font-semibold">Nome</th>
                <th className="px-6 py-4 font-semibold">Tipo</th>
                <th className="px-6 py-4 font-semibold">Status do Negócio</th>
                <th className="px-6 py-4 font-semibold">Plano</th>
                <th className="px-6 py-4 font-semibold">WhatsApp</th>
                <th className="px-6 py-4 font-semibold">Cadastro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {establishments.map((est) => (
                <tr key={est.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-4">
                    <Link href={`/admin/establishments/${est.id}`} className="font-medium text-sky-600 hover:underline">
                      {est.name || "Sem Nome"}
                    </Link>
                  </td>
                  <td className="px-6 py-4 text-slate-600 capitalize">
                    {est.type}
                  </td>
                  <td className="px-6 py-4">
                    {est.status === "active" ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                        Ativo
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                        Suspenso
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {est.billingStatus === "trial" ? (
                      <span className="text-blue-600 font-medium">Trial</span>
                    ) : est.billingStatus === "active" ? (
                      <span className="text-green-600 font-medium">Ativo</span>
                    ) : est.billingStatus === "past_due" ? (
                      <span className="text-yellow-600 font-medium">Atrasado</span>
                    ) : (
                      <span className="text-slate-500 font-medium">{est.billingStatus || "N/A"}</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {est.whatsappStatus === "connected" ? (
                      <span className="text-emerald-600 font-medium">Conectado</span>
                    ) : est.whatsappStatus === "connecting" ? (
                      <span className="text-amber-600 font-medium">Conectando...</span>
                    ) : (
                      <span className="text-slate-400">Desconectado</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-slate-500">
                    {est.createdAt ? new Intl.DateTimeFormat("pt-BR").format(new Date(est.createdAt)) : "N/A"}
                  </td>
                </tr>
              ))}
              {establishments.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">
                    Nenhum estabelecimento encontrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
