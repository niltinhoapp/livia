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
import { MessageCircle, AlertCircle, CheckCircle2 } from "lucide-react";
import { clientAuth, googleProvider } from "@/lib/firebase/client";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

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
  const next = params.get("next") || "/painel";

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
      setError('Digite seu e-mail acima e clique em "Esqueci minha senha" de novo.');
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
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-muted px-4 py-10">
      {/* Fundo sutil com a identidade roxa — sem imagem nem lib */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary-light/60 via-white to-surface-muted"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />

      <div className="relative w-full max-w-sm rounded-lg border border-line bg-white p-8 shadow-e3">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-card bg-primary text-white shadow-e2">
            <MessageCircle className="h-6 w-6" />
          </div>
          <h1 className="text-h2 text-ink-900">Entrar na Livia</h1>
          <p className="mt-1 text-sm text-ink-500">Acesse o painel do seu estabelecimento.</p>
        </div>

        <Button type="button" variant="secondary" className="w-full" onClick={withGoogle} disabled={busy}>
          <GoogleIcon />
          Continuar com Google
        </Button>

        <div className="my-5 flex items-center gap-3 text-xs text-ink-400">
          <div className="h-px flex-1 bg-line" />
          ou
          <div className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={withEmail} className="space-y-4">
          <div>
            <Label>E-mail</Label>
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@seunegocio.com.br"
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label>Senha</Label>
              <button
                type="button"
                onClick={forgotPassword}
                className="rounded-sm text-xs font-semibold text-primary hover:underline"
              >
                Esqueci minha senha
              </button>
            </div>
            <Input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <Button type="submit" className="w-full" loading={busy}>
            {busy ? "Entrando…" : "Entrar"}
          </Button>
        </form>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-control border border-danger/30 bg-danger-bg/50 px-3 py-2.5 text-sm text-danger-fg">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}
        {resetMsg && (
          <div className="mt-4 flex items-start gap-2 rounded-control border border-success/30 bg-success-bg/50 px-3 py-2.5 text-sm text-success-fg">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{resetMsg}</span>
          </div>
        )}
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4c-7.7 0-14.4 4.3-17.7 10.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.4 0 10.3-2.1 14-5.4l-6.5-5.5c-2 1.5-4.6 2.4-7.5 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.5 5.5C41.5 36 44 30.5 44 24c0-1.3-.1-2.7-.4-3.5z"
      />
    </svg>
  );
}
