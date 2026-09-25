import { db } from "@/lib/firebase/admin";
import type { Establishment, EstablishmentType, BillingStatus, EstablishmentWhatsapp } from "@/types";

export interface AdminDashboardMetrics {
  totalEstablishments: number;
  activeEstablishments: number;
  trialEstablishments: number;
  whatsappConnected: number;
}

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

export interface AdminEstablishmentDetailDTO extends AdminEstablishmentDTO {
  whatsappPhoneNumberId?: string;
  metrics: {
    conversations: number;
    campaigns: number;
  };
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

export async function getAdminEstablishmentDetail(id: string): Promise<AdminEstablishmentDetailDTO | null> {
  const doc = await db.collection("establishments").doc(id).get();
  if (!doc.exists) return null;

  const data = doc.data() as Establishment;

  const [convSnap, campSnap] = await Promise.all([
    doc.ref.collection("conversations").count().get(),
    db.collection("campaigns").where("establishmentId", "==", id).count().get()
  ]);

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
    whatsappPhoneNumberId: data.whatsapp?.phoneNumberId,
    metrics: {
      conversations: convSnap.data().count,
      campaigns: campSnap.data().count,
    }
  };
}

export async function extendAdminEstablishmentTrial(id: string, additionalDays: number): Promise<void> {
  const ref = db.collection("establishments").doc(id);
  const doc = await ref.get();
  
  if (!doc.exists) throw new Error("Establishment not found");

  const data = doc.data() as Establishment;
  const now = Date.now();
  
  let newTrialEndsAt = now + additionalDays * 24 * 60 * 60 * 1000;
  
  if (data.billing?.trialEndsAt && data.billing.trialEndsAt > now) {
    newTrialEndsAt = data.billing.trialEndsAt + additionalDays * 24 * 60 * 60 * 1000;
  }

  if (!data.billing) {
    await ref.update({
      billing: {
        billingStatus: "trial",
        trialStartAt: now,
        trialEndsAt: newTrialEndsAt
      },
      status: "active"
    });
    return;
  }

  await ref.update({
    "billing.trialEndsAt": newTrialEndsAt,
    "billing.billingStatus": "trial",
    status: "active"
  });
}
