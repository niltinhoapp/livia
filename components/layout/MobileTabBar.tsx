"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "./nav";

const PRIMARY_MOBILE_ROUTES = ["/painel", "/painel/agenda", "/painel/conversas", "/painel/campanhas"];

export function MobileTabBar() {
  const pathname = usePathname();
  const items = PRIMARY_MOBILE_ROUTES.map((href) => NAV_ITEMS.find((item) => item.href === href)).filter(
    (item): item is (typeof NAV_ITEMS)[number] => Boolean(item),
  );

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-primary-100 bg-white/95 shadow-[0_-4px_18px_rgba(124,58,237,0.08)] backdrop-blur lg:hidden">
      {items.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`relative flex min-w-0 flex-col items-center gap-1 px-1 py-2.5 text-[10px] font-medium leading-none transition-colors duration-150 ${active ? "text-primary" : "text-ink-400"}`}
          >
            {active && <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-primary" />}
            <span className={active ? "rounded-lg bg-primary-50 p-1" : "p-1"}>
              <Icon className="h-5 w-5 shrink-0" />
            </span>
            <span className="w-full truncate text-center">{item.mobileLabel}</span>
          </Link>
        );
      })}
    </nav>
  );
}
