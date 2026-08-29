"use client";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
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
      style={{
        background: "none",
        border: "1px solid #d0d5dd",
        borderRadius: 8,
        padding: "6px 14px",
        fontSize: 13,
        fontWeight: 600,
        color: "#344054",
        cursor: "pointer",
      }}
    >
      Sair
    </button>
  );
}
