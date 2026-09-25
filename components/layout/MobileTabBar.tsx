"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, X } from "lucide-react";
import { signOut } from "firebase/auth";
import { clientAuth } from "@/lib/firebase/client";
import { NAV_ITEMS, NAV_GROUPS } from "./nav";
import type { ShellUser } from "@/components/hooks/useShellData";

const LEFT_ROUTES = ["/painel", "/painel/agenda"];
const RIGHT_ROUTES = ["/painel/pedidos", "/painel/conversas"];
const PRIMARY_MOBILE_ROUTES = [...LEFT_ROUTES, ...RIGHT_ROUTES];

export function MobileTabBar({ user }: { user?: ShellUser | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const primaryItems = PRIMARY_MOBILE_ROUTES.map((href) =>
    NAV_ITEMS.find((item) => item.href === href),
  ).filter((item): item is (typeof NAV_ITEMS)[number] => Boolean(item));
  const extraItems = NAV_ITEMS.filter((item) => !PRIMARY_MOBILE_ROUTES.includes(item.href));
  const isActive = (href: string) =>
    href === "/painel"
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);
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
        className={`relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 px-1 py-2 text-[10px] font-medium leading-none transition-colors duration-150 ${
          active ? "text-primary" : "text-ink-400 hover:text-ink-600"
        }`}
      >
        {active && <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-primary" />}
        <span
          className={
            active
              ? "rounded-lg bg-primary-50 p-1 text-primary dark:bg-primary-900/50"
              : "p-1"
          }
        >
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
          <button
            aria-label="Fechar menu"
            className="fixed inset-0 z-40 bg-ink-950/40 backdrop-blur-[2px] transition-opacity lg:hidden"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-x-3 bottom-20 z-50 max-h-[75vh] overflow-y-auto rounded-card border border-line bg-white p-4 shadow-e3 dark:border-ink-700 dark:bg-ink-900 lg:hidden">
            <div className="mb-3 flex items-center justify-between border-b border-line pb-3 dark:border-ink-700">
              <div>
                <p className="text-sm font-bold text-ink-900">Menu do painel</p>
                <p className="text-xs text-ink-500">Mais áreas e configurações</p>
              </div>
              <button
                aria-label="Fechar menu"
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-control text-ink-400 hover:bg-ink-50 hover:text-ink-700 dark:hover:bg-ink-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              {NAV_GROUPS.map((group) => {
                const groupItems = extraItems.filter((item) => item.group === group.id);
                if (groupItems.length === 0) return null;
                return (
                  <div key={group.id}>
                    <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                      {group.label}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {groupItems.map((item) => {
                        const active = isActive(item.href);
                        const Icon = item.icon;
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            onClick={() => setOpen(false)}
                            className={`flex min-h-12 items-center gap-2.5 rounded-control border px-3 py-2 text-sm font-medium transition-colors ${
                              active
                                ? "border-primary/40 bg-primary-50 text-primary-700 dark:bg-primary-900/40 dark:text-primary-200"
                                : "border-line bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200"
                            }`}
                          >
                            <span
                              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                                active ? "bg-primary text-white" : "bg-ink-100 text-ink-600"
                              }`}
                            >
                              <Icon className="h-4 w-4" />
                            </span>
                            <span className="truncate">{item.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {user && (
              <div className="border-t border-line pt-3 dark:border-ink-700">
                <div className="flex items-center gap-3 px-1 pb-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full overflow-hidden">
                    {user.photo ? (
                      <img src={user.photo} alt="" referrerPolicy="no-referrer" className="h-full w-full rounded-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center rounded-full bg-primary-light text-xs font-semibold text-primary">
                        {user.name?.[0]?.toUpperCase() || user.email?.[0]?.toUpperCase() || "?"}
                      </span>
                    )}
                  </span>
                  <div className="min-w-0">
                    {user.name && <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-100">{user.name}</p>}
                    {user.email && <p className="truncate text-xs text-ink-400">{user.email}</p>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch("/api/auth/session", { method: "DELETE" });
                    await signOut(clientAuth).catch(() => {});
                    router.push("/login");
                    router.refresh();
                  }}
                  className="flex w-full items-center gap-2 rounded-control px-1 py-2 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-800"
                >
                  <LogOut className="h-4 w-4" />
                  Sair
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-line bg-white/95 shadow-[0_-4px_18px_rgba(16,24,40,0.06)] backdrop-blur dark:border-ink-700 dark:bg-ink-900/95 lg:hidden">
        {leftItems.map(renderItem)}
        <button
          type="button"
          aria-expanded={open}
          aria-label="Abrir menu do painel"
          onClick={() => setOpen((value) => !value)}
          className={`relative flex min-h-14 flex-col items-center justify-center gap-1 text-[10px] font-semibold transition-colors ${
            open || extraItems.some((item) => isActive(item.href))
              ? "text-primary"
              : "text-ink-400 hover:text-ink-600"
          }`}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-white shadow-e2 transition-transform active:scale-95">
            <Menu className="h-4 w-4" />
          </span>
          <span>Menu</span>
        </button>
        {rightItems.map(renderItem)}
      </nav>
    </>
  );
}
