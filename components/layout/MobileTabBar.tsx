"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "./nav";

export function MobileTabBar() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-white/95 backdrop-blur lg:hidden">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`relative flex flex-1 flex-col items-center gap-1 px-0.5 py-2.5 text-[10px] font-medium leading-none transition-colors duration-150 ${
              active ? "text-primary" : "text-ink-400"
            }`}
          >
            {active && <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary" />}
            <Icon className="h-5 w-5 shrink-0" />
            <span className="w-full truncate text-center">{item.mobileLabel}</span>
          </Link>
        );
      })}
    </nav>
  );
}
