// Firebase client SDK — SOMENTE para autenticação no navegador (tela de
// login). Config pública (não é segredo); nenhum dado do Firestore é lido
// pelo client — isso continua exclusivo do Admin SDK no servidor.
import { getApps, getApp, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseClientApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const clientAuth = getAuth(firebaseClientApp);
export const googleProvider = new GoogleAuthProvider();
