"use client";

import { useRef, useState, useEffect } from "react";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { clientAuth } from "@/lib/firebase/client";
import type { ShellUser } from "@/components/hooks/useShellData";

export function UserMenu({ user }: { user: ShellUser | null | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function logout() {
    await fetch("/api/auth/session", { method: "DELETE" });
    await signOut(clientAuth).catch(() => {});
    router.push("/login");
    router.refresh();
  }

  const displayName = user?.name || null;
  const email = user?.email || null;
  const photo = user?.photo || null;
  const initials = displayName
    ? displayName.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : email
      ? email[0]!.toUpperCase()
      : "?";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Menu da conta"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line shadow-e1 transition-colors hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600 overflow-hidden"
      >
        {photo ? (
          <img
            src={photo}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full rounded-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center rounded-full bg-primary-light text-xs font-semibold text-primary">
            {initials}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-card border border-line bg-white p-3 shadow-e3 dark:border-ink-700 dark:bg-ink-900">
          <div className="flex items-center gap-3 pb-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full overflow-hidden">
              {photo ? (
                <img src={photo} alt="" referrerPolicy="no-referrer" className="h-full w-full rounded-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center rounded-full bg-primary-light text-sm font-semibold text-primary">
                  {initials}
                </span>
              )}
            </span>
            <div className="min-w-0">
              {displayName && (
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-100">{displayName}</p>
              )}
              {email && (
                <p className="truncate text-xs text-ink-400">{email}</p>
              )}
            </div>
          </div>
          <div className="border-t border-line pt-2 dark:border-ink-700">
            <button
              type="button"
              onClick={logout}
              className="flex w-full items-center gap-2 rounded-control px-2 py-2 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-ink-100"
            >
              <LogOut className="h-4 w-4" />
              Sair
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
