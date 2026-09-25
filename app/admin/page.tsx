export default function AdminPage() {
  return (
    <div className="flex flex-col items-start justify-center h-full">
      <h1 className="text-3xl font-bold text-slate-900">Painel Administrativo</h1>
      <p className="mt-2 text-lg text-slate-500">Lívia • ConectWeb</p>
      
      <div className="mt-8 p-6 bg-white border border-slate-200 rounded-lg shadow-sm w-full max-w-3xl">
        <h2 className="text-xl font-semibold text-slate-800 mb-4">Bem-vindo(a)</h2>
        <p className="text-slate-600">
          Você está acessando a área restrita da plataforma. Métricas e funcionalidades
          administrativas serão implementadas nas próximas etapas.
        </p>
      </div>
    </div>
  );
}
