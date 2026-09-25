import { db } from "@/lib/firebase/admin";
import type { Establishment, EstablishmentType, BillingStatus, EstablishmentWhatsapp } from "@/types";

export interface AdminDashboardMetrics {
  totalEstablishments: number;
  activeEstablishments: number;
  trialEstablishments: number;
  whatsappConnected: number;
}

// DTO seguro: nunca retorna tokens, pins ou chaves privadas.
export interface AdminEstablishmentDTO {
  id: string;
  name: string;
  type: EstablishmentType;
  ownerUid: string;
  status: "active" | "suspended";
  createdAt: number;
  billingStatus?: BillingStatus;
  trialEndsAt?: number;
  whatsappStatus?: "connecting" | "connected" | "disconnected";
  whatsappConnectedAt?: number;
}

export async function getAdminDashboardMetrics(): Promise<AdminDashboardMetrics> {
  const collection = db.collection("establishments");

  const [totalSnap, activeSnap, trialSnap, waConnectedSnap] = await Promise.all([
    collection.count().get(),
    collection.where("status", "==", "active").count().get(),
    collection.where("billing.billingStatus", "==", "trial").count().get(),
    collection.where("whatsapp.status", "==", "connected").count().get(),
  ]);

  return {
    totalEstablishments: totalSnap.data().count,
    activeEstablishments: activeSnap.data().count,
    trialEstablishments: trialSnap.data().count,
    whatsappConnected: waConnectedSnap.data().count,
  };
}

export async function listAdminEstablishments(): Promise<AdminEstablishmentDTO[]> {
  const snap = await db.collection("establishments").orderBy("createdAt", "desc").get();
  
  return snap.docs.map((doc) => {
    const data = doc.data() as Establishment;
    
    return {
      id: data.id,
      name: data.name,
      type: data.type,
      ownerUid: data.ownerUid,
      status: data.status,
      createdAt: data.createdAt,
      billingStatus: data.billing?.billingStatus,
      trialEndsAt: data.billing?.trialEndsAt,
      whatsappStatus: data.whatsapp?.status,
      whatsappConnectedAt: data.whatsapp?.connectedAt,
    };
  });
}
