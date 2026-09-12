"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "./nav";
import { ESTABLISHMENT_TYPE_LABELS } from "@/components/lib/labels";
import type { ShellData } from "@/components/hooks/useShellData";
import LogoutButton from "@/app/painel/LogoutButton";

export function Header({ data }: { data: ShellData | null }) {
  const pathname = usePathname();
  const title = NAV_ITEMS.find((i) => i.href === pathname)?.label ?? "Livia";

  return (
    <header className="flex items-center justify-between border-b border-line bg-white px-4 py-4 sm:px-6">
      <div>
        <p className="text-lg font-bold text-ink-900">{title}</p>
        {data && (
          <p className="text-xs text-ink-400">
            {data.name || "Seu negócio"} · {ESTABLISHMENT_TYPE_LABELS[data.type]}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Link
          href="/painel/whatsapp"
          className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium sm:inline-flex ${
            data?.whatsappConnected ? "border-success/30 text-success-fg" : "border-warning/40 text-warning-fg"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${data?.whatsappConnected ? "bg-success" : "bg-warning"}`} />
          {data?.whatsappConnected ? "WhatsApp conectado" : "WhatsApp não conectado"}
        </Link>
        <LogoutButton />
      </div>
    </header>
  );
}
