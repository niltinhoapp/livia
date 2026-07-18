// Firebase Admin SDK — SOMENTE no servidor (API routes).
// Tokens, conversas e bases de conhecimento nunca são lidos pelo client.
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let app: App;

if (!getApps().length) {
  app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
} else {
  app = getApps()[0]!;
}

export const db = getFirestore(app);

// Helpers de caminho multi-tenant. Tudo sob establishments/{id}/...
export const establishmentRef = (id: string) =>
  db.collection("establishments").doc(id);
export const sub = (establishmentId: string, name: string) =>
  establishmentRef(establishmentId).collection(name);
