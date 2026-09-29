// Ativa os avisos de atendimento humano NESTE aparelho (navegador/PWA).
// Push na web depende de permissão do usuário e do suporte do navegador; no
// iPhone, só com o painel adicionado à Tela de Início. Nunca é garantido.
export type EnablePushResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "not_configured" | "denied" | "failed" };

const TOKEN_STORAGE_KEY = "livia.handoffPushToken";

export function pushConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY && process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID);
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function pushEnabledHere(): boolean {
  try {
    return pushSupported() && Notification.permission === "granted" && Boolean(window.localStorage.getItem(TOKEN_STORAGE_KEY));
  } catch {
    return false;
  }
}

export async function enableHandoffPush(): Promise<EnablePushResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!pushConfigured()) return { ok: false, reason: "not_configured" };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "denied" };
    const registration = await navigator.serviceWorker.register("/sw.js");
    const [{ getMessaging, getToken, isSupported }, { firebaseClientApp }] = await Promise.all([
      import("firebase/messaging"),
      import("@/lib/firebase/client"),
    ]);
    if (!(await isSupported())) return { ok: false, reason: "unsupported" };
    const token = await getToken(getMessaging(firebaseClientApp), {
      vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
      serviceWorkerRegistration: registration,
    });
    if (!token) return { ok: false, reason: "failed" };
    const res = await fetch("/api/human-handoff/push-devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return { ok: false, reason: "failed" };
    try { window.localStorage.setItem(TOKEN_STORAGE_KEY, token); } catch { /* só conveniência local */ }
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export async function disableHandoffPush(): Promise<void> {
  let token: string | null = null;
  try { token = window.localStorage.getItem(TOKEN_STORAGE_KEY); } catch { /* sem armazenamento local */ }
  if (!token) return;
  await fetch("/api/human-handoff/push-devices", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => undefined);
  try { window.localStorage.removeItem(TOKEN_STORAGE_KEY); } catch { /* idem */ }
}
