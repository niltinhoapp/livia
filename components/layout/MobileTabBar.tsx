"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { NAV_ITEMS } from "./nav";

const LEFT_ROUTES = ["/painel", "/painel/agenda"];
const RIGHT_ROUTES = ["/painel/conversas", "/painel/campanhas"];
const PRIMARY_MOBILE_ROUTES = [...LEFT_ROUTES, ...RIGHT_ROUTES];

export function MobileTabBar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const primaryItems = PRIMARY_MOBILE_ROUTES.map((href) => NAV_ITEMS.find((item) => item.href === href)).filter(
    (item): item is (typeof NAV_ITEMS)[number] => Boolean(item),
  );
  const extraItems = NAV_ITEMS.filter((item) => !PRIMARY_MOBILE_ROUTES.includes(item.href));
  const isActive = (href: string) => href === "/painel" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  const leftItems = primaryItems.filter((item) => LEFT_ROUTES.includes(item.href));
  const rightItems = primaryItems.filter((item) => RIGHT_ROUTES.includes(item.href));

  const renderItem = (item: (typeof NAV_ITEMS)[number]) => {
    const active = isActive(item.href);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        onClick={() => setOpen(false)}
        className={`relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 px-1 py-2 text-[10px] font-medium leading-none transition-colors duration-150 ${active ? "text-primary" : "text-ink-400"}`}
      >
        {active && <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-primary" />}
        <span className={active ? "rounded-lg bg-primary-50 p-1 dark:bg-primary-900/50" : "p-1"}>
          <Icon className="h-5 w-5 shrink-0" />
        </span>
        <span className="w-full truncate text-center">{item.mobileLabel}</span>
      </Link>
    );
  };

  return (
    <>
      {open && (
        <>
          <button aria-label="Fechar menu" className="fixed inset-0 z-40 bg-ink-950/40 backdrop-blur-[1px] lg:hidden" onClick={() => setOpen(false)} />
          <div className="fixed inset-x-3 bottom-20 z-50 rounded-card border border-line bg-white p-3 shadow-e3 dark:border-ink-700 dark:bg-ink-900 lg:hidden">
            <div className="mb-2 flex items-center justify-between px-1">
              <div><p className="text-sm font-semibold text-ink-900">Menu do painel</p><p className="text-xs text-ink-500">Configurações e outras áreas</p></div>
              <button aria-label="Fechar menu" onClick={() => setOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-control text-ink-500 hover:bg-ink-50 dark:hover:bg-ink-800"><X className="h-5 w-5" /></button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {extraItems.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                return <Link key={item.href} href={item.href} onClick={() => setOpen(false)} className={`flex min-h-12 items-center gap-3 rounded-control border px-3 py-2.5 text-sm font-semibold ${active ? "border-primary/30 bg-primary-50 text-primary-700 dark:bg-primary-900/40 dark:text-primary-200" : "border-line bg-white text-ink-700 dark:border-ink-700 dark:bg-ink-900"}`}><Icon className="h-4 w-4 shrink-0" />{item.label}</Link>;
              })}
            </div>
          </div>
        </>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-primary-100 bg-white/95 shadow-[0_-4px_18px_rgba(124,58,237,0.08)] backdrop-blur dark:border-ink-700 dark:bg-ink-900/95 lg:hidden">
        {leftItems.map(renderItem)}
        <button
          type="button"
          aria-expanded={open}
          aria-label="Abrir menu do painel"
          onClick={() => setOpen((value) => !value)}
          className={`relative flex min-h-14 flex-col items-center justify-center gap-1 text-[10px] font-semibold ${open || extraItems.some((item) => isActive(item.href)) ? "text-primary" : "text-ink-400"}`}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-white shadow-e2"><Menu className="h-5 w-5" /></span>
          <span>Menu</span>
        </button>
        {rightItems.map(renderItem)}
      </nav>
    </>
  );
}
