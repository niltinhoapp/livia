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
            className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium ${
              active ? "text-primary" : "text-ink-400"
            }`}
          >
            <Icon className="h-5 w-5" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
