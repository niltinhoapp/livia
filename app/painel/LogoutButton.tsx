"use client";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { LogOut } from "lucide-react";
import { clientAuth } from "@/lib/firebase/client";

export default function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/session", { method: "DELETE" });
    await signOut(clientAuth).catch(() => {});
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={logout}
      className="inline-flex items-center gap-2 rounded-control border border-line px-3 py-2 text-sm font-semibold text-ink-700 transition-colors hover:bg-line/30"
    >
      <LogOut className="h-4 w-4" />
      <span className="hidden sm:inline">Sair</span>
    </button>
  );
}
