import type { ReactNode } from "react";
import Link from "next/link";
import { LayoutDashboard } from "lucide-react";

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-slate-50">
      <aside className="w-64 bg-slate-900 text-white flex flex-col border-r border-slate-800">
        <div className="p-6">
          <h2 className="text-xl font-bold text-sky-400">Lívia Admin</h2>
          <p className="text-xs text-slate-400 mt-1">ConectWeb</p>
        </div>
        <nav className="flex-1 px-4 space-y-2 mt-4">
          <Link
            href="/admin"
            className="flex items-center gap-3 px-4 py-2.5 rounded-md bg-slate-800 text-white font-medium hover:bg-slate-700 transition-colors"
          >
            <LayoutDashboard className="h-5 w-5 text-sky-400" />
            Dashboard
          </Link>
          {/* Outros links de navegação virão depois (Estabelecimentos, etc) */}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-8">
        {children}
      </main>
    </div>
  );
}
