"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { NAV_ITEMS, NAV_GROUPS } from "./nav";
import { Avatar } from "@/components/ui/Avatar";
import { ESTABLISHMENT_TYPE_LABELS } from "@/components/lib/labels";
import type { ShellData } from "@/components/hooks/useShellData";

export function Sidebar({ data }: { data?: ShellData | null }) {
  const pathname = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-primary-100 bg-gradient-to-b from-primary-50 via-white to-white lg:flex">
      <div className="flex items-center gap-2.5 px-6 py-6">
        <span className="flex h-9 w-9 items-center justify-center rounded-control bg-primary text-white shadow-e2"><MessageCircle className="h-4 w-4" /></span>
        <div><span className="text-xl font-bold text-primary-800">Livia</span><p className="text-[10px] font-semibold uppercase tracking-wider text-primary-400">Assistente IA</p></div>
      </div>
      <nav className="flex-1 space-y-6 px-3">
        {NAV_GROUPS.map((g) => (
          <div key={g.id} className="space-y-1">
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-primary-400">{g.label}</p>
            {NAV_ITEMS.filter((i) => i.group === g.id).map((item) => {
              const active = pathname === item.href; const Icon = item.icon;
              return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-semibold transition-all duration-150 ${active ? "bg-primary text-white shadow-e1" : "text-ink-600 hover:bg-primary-50 hover:text-primary-700"}`}><Icon className="h-[18px] w-[18px]" />{item.label}</Link>;
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-primary-100 bg-primary-50/60 p-3"><div className="flex items-center gap-3 rounded-control px-2 py-2"><Avatar name={data?.name} size="sm" /><div className="min-w-0"><p className="truncate text-sm font-semibold text-ink-900">{data?.name || "Seu negócio"}</p>{data && <p className="truncate text-xs text-primary-500">{ESTABLISHMENT_TYPE_LABELS[data.type]}</p>}</div></div></div>
    </aside>
  );
}
