"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircle, MessageCircleOff } from "lucide-react";
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
          className={`hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold sm:inline-flex ${
            data?.whatsappConnected ? "bg-success-bg text-success-fg" : "bg-warning-bg text-warning-fg"
          }`}
        >
          {data?.whatsappConnected ? <MessageCircle className="h-3.5 w-3.5" /> : <MessageCircleOff className="h-3.5 w-3.5" />}
          {data?.whatsappConnected ? "WhatsApp conectado" : "WhatsApp não conectado"}
        </Link>
        <LogoutButton />
      </div>
    </header>
  );
}
