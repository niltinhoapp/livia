// Push do responsável via Firebase Cloud Messaging (Admin SDK já usado no
// projeto). Push é aviso, nunca estado: falha aqui não muda a conversa.
import { createHash } from "node:crypto";
import { getMessaging } from "firebase-admin/messaging";
import { db, firebaseAdminApp, sub } from "@/lib/firebase/admin";
import type { PushDevice } from "@/types";

const MAX_DEVICES = 20;
// Tokens que o FCM declara mortos: removidos para não serem tentados de novo.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

export function pushDeviceId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 40);
}

export async function registerPushDevice(
  establishmentId: string,
  input: { token: string; uid: string; userAgent: string | null },
  now = Date.now(),
): Promise<PushDevice> {
  const id = pushDeviceId(input.token);
  const ref = sub(establishmentId, "pushDevices").doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const device: PushDevice = snap.exists
      ? { ...(snap.data() as PushDevice), uid: input.uid, userAgent: input.userAgent, lastSeenAt: now }
      : { id, token: input.token, uid: input.uid, userAgent: input.userAgent, createdAt: now, lastSeenAt: now };
    tx.set(ref, device);
    return device;
  });
}

export async function unregisterPushDevice(establishmentId: string, token: string): Promise<void> {
  await sub(establishmentId, "pushDevices").doc(pushDeviceId(token)).delete();
}

export async function countPushDevices(establishmentId: string): Promise<number> {
  return (await sub(establishmentId, "pushDevices").limit(MAX_DEVICES).get()).size;
}

export interface HandoffPushMessage {
  title: string;
  body: string;
  // Caminho relativo do painel; o service worker abre na própria origem.
  url: string;
  tag: string;
}

export type PushOutcome =
  | { kind: "sent"; delivered: number }
  | { kind: "skipped"; reason: string }
  // Todos os aparelhos recusados de forma definitiva (token morto).
  | { kind: "permanent"; reason: string }
  // FCM/rede indisponível: vale tentar de novo (tentativas limitadas).
  | { kind: "transient"; reason: string };

export async function sendHandoffPush(establishmentId: string, message: HandoffPushMessage): Promise<PushOutcome> {
  const snap = await sub(establishmentId, "pushDevices").limit(MAX_DEVICES).get();
  const devices = snap.docs.map((doc) => doc.data() as PushDevice).filter((d) => typeof d.token === "string" && d.token);
  if (devices.length === 0) return { kind: "skipped", reason: "no_devices" };
  try {
    const response = await getMessaging(firebaseAdminApp).sendEachForMulticast({
      tokens: devices.map((d) => d.token),
      data: { title: message.title, body: message.body, url: message.url, tag: message.tag },
      // Topic: o serviço de push substitui uma mensagem ainda não entregue com
      // o mesmo tópico — um reenvio do mesmo aviso não empilha no aparelho.
      webpush: { headers: { Urgency: "high", TTL: "86400", Topic: createHash("sha256").update(message.tag).digest("hex").slice(0, 32) } },
    });
    let dead = 0;
    await Promise.all(response.responses.map(async (result, index) => {
      if (!result.success && result.error && DEAD_TOKEN_CODES.has(result.error.code)) {
        dead++;
        await sub(establishmentId, "pushDevices").doc(devices[index]!.id).delete();
      }
    }));
    if (response.successCount > 0) return { kind: "sent", delivered: response.successCount };
    if (dead === devices.length) return { kind: "permanent", reason: "no_valid_devices" };
    return { kind: "transient", reason: response.responses.find((r) => r.error)?.error?.code ?? "push_failed" };
  } catch (error) {
    return { kind: "transient", reason: error instanceof Error ? error.name : "push_failed" };
  }
}
