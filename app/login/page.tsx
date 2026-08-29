"use client";
// Login do painel: Google (principal) + e-mail/senha (alternativa), com
// recuperação de senha. Os dois métodos terminam no mesmo fluxo seguro:
// Firebase Auth (client) -> ID token -> POST /api/auth/session (backend
// valida e cria o cookie httpOnly) -> redireciona pro painel.
import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
} from "firebase/auth";
import { clientAuth, googleProvider } from "@/lib/firebase/client";

const box: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #d0d5dd",
  fontSize: 15,
  fontFamily: "inherit",
  boxSizing: "border-box",
};
const btnPrimary: React.CSSProperties = {
  background: "#7c3aed",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "11px 16px",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  width: "100%",
};
const btnGoogle: React.CSSProperties = {
  background: "#fff",
  color: "#344054",
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  padding: "11px 16px",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  width: "100%",
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/painel/config";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  async function finishLogin(idToken: string) {
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) throw new Error("Não foi possível criar a sessão.");
    router.push(next);
    router.refresh();
  }

  async function withGoogle() {
    setError(null);
    setBusy(true);
    try {
      const cred = await signInWithPopup(clientAuth, googleProvider);
      const idToken = await cred.user.getIdToken();
      await finishLogin(idToken);
    } catch {
      setError("Não foi possível entrar com Google. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  async function withEmail(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResetMsg(null);
    setBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(clientAuth, email, password);
      const idToken = await cred.user.getIdToken();
      await finishLogin(idToken);
    } catch {
      setError("E-mail ou senha incorretos.");
    } finally {
      setBusy(false);
    }
  }

  async function forgotPassword() {
    setError(null);
    setResetMsg(null);
    if (!email) {
      setError("Digite seu e-mail acima e clique em \"Esqueci minha senha\" de novo.");
      return;
    }
    try {
      await sendPasswordResetEmail(clientAuth, email);
      setResetMsg("Enviamos um link de redefinição de senha para o seu e-mail.");
    } catch {
      setError("Não foi possível enviar o e-mail de redefinição.");
    }
  }

  return (
    <main style={{ maxWidth: 380, margin: "80px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Entrar na Livia</h1>
      <p style={{ color: "#667085", marginTop: 0, marginBottom: 24 }}>
        Acesse o painel do seu estabelecimento.
      </p>

      <button style={btnGoogle} onClick={withGoogle} disabled={busy}>
        Continuar com Google
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0", color: "#98a2b3", fontSize: 13 }}>
        <div style={{ flex: 1, height: 1, background: "#eaecf0" }} />
        ou
        <div style={{ flex: 1, height: 1, background: "#eaecf0" }} />
      </div>

      <form onSubmit={withEmail}>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontWeight: 600, fontSize: 14, display: "block", marginBottom: 6 }}>E-mail</label>
          <input
            style={box}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="voce@seunegocio.com.br"
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={{ fontWeight: 600, fontSize: 14, display: "block", marginBottom: 6 }}>Senha</label>
          <input
            style={box}
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <button
          type="button"
          onClick={forgotPassword}
          style={{ background: "none", border: "none", color: "#7c3aed", fontSize: 13, cursor: "pointer", padding: 0, marginBottom: 16 }}
        >
          Esqueci minha senha
        </button>
        <button style={btnPrimary} type="submit" disabled={busy}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>

      {error && <p style={{ color: "#d92d20", fontSize: 14, marginTop: 16 }}>{error}</p>}
      {resetMsg && <p style={{ color: "#12b76a", fontSize: 14, marginTop: 16 }}>{resetMsg}</p>}
    </main>
  );
}
