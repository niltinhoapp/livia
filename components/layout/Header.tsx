"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Moon, Sun } from "lucide-react";
import { NAV_ITEMS } from "./nav";
import { ESTABLISHMENT_TYPE_LABELS } from "@/components/lib/labels";
import type { ShellData } from "@/components/hooks/useShellData";
import LogoutButton from "@/app/painel/LogoutButton";

export function Header({ data }: { data: ShellData | null }) {
  const pathname = usePathname();
  const title = NAV_ITEMS.find((i) => i.href === pathname)?.label ?? "Livia";
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("livia-theme");
    const enabled =
      saved === "dark" ||
      (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", enabled);
    setDark(enabled);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("livia-theme", next ? "dark" : "light");
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-line bg-white/95 px-4 shadow-[0_1px_2px_rgba(16,24,40,0.03)] backdrop-blur-sm dark:border-ink-700 dark:bg-ink-900/95 sm:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-base font-bold text-ink-900 sm:text-lg">{title}</h1>
        {data && (
          <p className="truncate text-xs text-ink-400">
            {data.name || "Seu negócio"} · {ESTABLISHMENT_TYPE_LABELS[data.type]}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <Link
          href="/painel/whatsapp"
          className={`hidden items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors duration-150 sm:inline-flex ${
            data?.whatsappConnected
              ? "border-success/30 bg-success-bg/40 text-success-fg hover:bg-success-bg/60"
              : "border-warning/30 bg-warning-bg/40 text-warning-fg hover:bg-warning-bg/60"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              data?.whatsappConnected ? "bg-success" : "bg-warning"
            }`}
          />
          {data?.whatsappConnected ? "WhatsApp conectado" : "WhatsApp desconectado"}
        </Link>

        <button
          type="button"
          onClick={toggle}
          aria-label={dark ? "Ativar modo claro" : "Ativar modo escuro"}
          title={dark ? "Modo claro" : "Modo escuro"}
          className="flex h-9 w-9 items-center justify-center rounded-control border border-line bg-white text-ink-600 shadow-e1 transition-colors hover:border-ink-300 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700"
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        <LogoutButton />
      </div>
    </header>
  );
}
