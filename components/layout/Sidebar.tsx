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
    <aside className="hidden w-60 shrink-0 flex-col bg-primary-900 text-white shadow-e3 lg:flex">
      <div className="flex items-center gap-2.5 border-b border-white/10 px-6 py-6">
        <span className="flex h-10 w-10 items-center justify-center rounded-control bg-white text-primary-700 shadow-e2"><MessageCircle className="h-5 w-5" /></span>
        <div><span className="text-xl font-bold text-white">Livia</span><p className="text-[10px] font-semibold uppercase tracking-wider text-primary-200">Assistente IA</p></div>
      </div>
      <nav className="flex-1 space-y-6 px-3 py-5">
        {NAV_GROUPS.map((g) => (
          <div key={g.id} className="space-y-1">
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-primary-300">{g.label}</p>
            {NAV_ITEMS.filter((i) => i.group === g.id).map((item) => {
              const active = item.href === "/painel" ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`); const Icon = item.icon;
              return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`relative flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-semibold transition-all duration-150 ${active ? "bg-white text-primary-800 shadow-e2" : "text-primary-100 hover:bg-white/10 hover:text-white"}`}>{active && <span className="absolute -left-1 h-5 w-1 rounded-full bg-primary-300" />}<Icon className="h-[18px] w-[18px]" />{item.label}</Link>;
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-white/10 bg-black/10 p-3">
        <div className="flex items-center gap-3 rounded-control px-2 py-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full overflow-hidden">
            {data?.user?.photo ? (
              <img src={data.user.photo} alt="" referrerPolicy="no-referrer" className="h-full w-full rounded-full object-cover" />
            ) : (
              <Avatar name={data?.user?.name || data?.name} size="sm" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{data?.user?.name || data?.name || "Seu negócio"}</p>
            {data?.user?.email ? (
              <p className="truncate text-xs text-primary-200">{data.user.email}</p>
            ) : data ? (
              <p className="truncate text-xs text-primary-200">{ESTABLISHMENT_TYPE_LABELS[data.type]}</p>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}
