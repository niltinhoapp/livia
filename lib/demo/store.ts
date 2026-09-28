// Persistência do ambiente de demonstração (F2).
//
// Duas responsabilidades, ambas explícitas e resetáveis:
//
//   1. o CENÁRIO baseline (establishments/{id}/meta/demoScenario);
//   2. o LIFECYCLE dos registros de uma sessão de demonstração.
//
// Segue a convenção já documentada em lib/attachments/storage.ts e aplicada em
// lib/demoSafety.ts na F0: nenhum import de @/lib/firebase/admin no topo do
// módulo, para que importar o webhook não inicialize credenciais.
import type { DemoScenario } from "@/types";
import { defaultDemoScenario, normalizeDemoScenario } from "./scenario";

const admin = () => import("@/lib/firebase/admin");

/**
 * Cenário do tenant. Ausência do documento devolve o default — a demonstração
 * funciona antes de qualquer seed, e o seed serve para CUSTOMIZAR, não para
 * habilitar.
 */
export async function getDemoScenario(establishmentId: string, now = Date.now()): Promise<DemoScenario> {
  const { sub } = await admin();
  const snap = await sub(establishmentId, "meta").doc("demoScenario").get();
  if (!snap.exists) return defaultDemoScenario(establishmentId, now);
  return normalizeDemoScenario(establishmentId, snap.data(), now);
}

/** Grava/substitui o cenário. Normaliza antes: documento inválido nunca entra. */
export async function saveDemoScenario(
  establishmentId: string,
  scenario: Partial<DemoScenario>,
  now = Date.now(),
): Promise<DemoScenario> {
  const normalized = normalizeDemoScenario(establishmentId, { ...scenario, updatedAt: now }, now);
  const { sub } = await admin();
  await sub(establishmentId, "meta").doc("demoScenario").set(normalized);
  return normalized;
}

/** Volta ao cenário default, removendo qualquer customização. */
export async function resetDemoScenario(establishmentId: string, now = Date.now()): Promise<DemoScenario> {
  return saveDemoScenario(establishmentId, defaultDemoScenario(establishmentId, now), now);
}

export interface DemoSessionCleanupResult {
  appointments: number;
  orders: number;
}

// Teto por chamada: a limpeza é de UMA sessão de demonstração, que nunca tem
// volume alto. Existe para nunca virar varredura ilimitada.
const CLEANUP_LIMIT = 200;

/**
 * Apaga os registros de demonstração de UM lead.
 *
 * Escopado por `prospectingLeadId` — nunca por telefone, nunca global. É essa
 * chave que garante o requisito da F2: um reset do prospect A não pode
 * destruir a sessão do prospect B, e nada de produção é alcançável porque toda
 * query exige `mode == "demo"`.
 *
 * O baseline não é tocado: ele não é persistido.
 */
export async function cleanupDemoSession(
  establishmentId: string,
  prospectingLeadId: string,
): Promise<DemoSessionCleanupResult> {
  if (!prospectingLeadId) return { appointments: 0, orders: 0 };
  const { sub } = await admin();

  const result: DemoSessionCleanupResult = { appointments: 0, orders: 0 };
  for (const collection of ["appointments", "orders"] as const) {
    const collectionRef = sub(establishmentId, collection);
    const snap = await collectionRef
      .where("mode", "==", "demo")
      .where("prospectingLeadId", "==", prospectingLeadId)
      .limit(CLEANUP_LIMIT)
      .get();
    if (snap.empty) continue;

    // Deleção por id, documento a documento: é uma operação administrativa de
    // volume baixo (teto de CLEANUP_LIMIT por chamada), e o caminho simples
    // evita depender de primitivas a mais do driver.
    await Promise.all(snap.docs.map((doc) => collectionRef.doc(doc.id).delete()));
    result[collection] = snap.size;

    // O draft ativo aponta para um pedido que acabou de deixar de existir.
    if (collection === "orders") {
      for (const doc of snap.docs) {
        const order = doc.data() as { conversationId?: string };
        if (!order.conversationId) continue;
        await sub(establishmentId, "conversations")
          .doc(order.conversationId)
          .set({ activeOrderId: null }, { merge: true });
      }
    }
  }
  return result;
}

/**
 * Sessões de demonstração vencidas e ainda com resíduo.
 *
 * Fonte da expiração é a própria `ProspectingSession.expiresAt`, que já existe
 * e já governa o fim da demonstração — a F2 não cria um segundo relógio. A
 * limpeza é por lead, então processar uma sessão vencida nunca interfere numa
 * sessão ativa.
 */
export async function listExpiredDemoLeads(
  establishmentId: string,
  now = Date.now(),
  limit = 50,
): Promise<string[]> {
  const { sub } = await admin();
  const snap = await sub(establishmentId, "prospectingSessions")
    .where("expiresAt", "<", now)
    .limit(limit)
    .get();
  return snap.docs
    .map((doc) => (doc.data() as { leadId?: string }).leadId)
    .filter((leadId): leadId is string => typeof leadId === "string" && leadId.length > 0);
}
