// Criptografia em repouso dos tokens de acesso do WhatsApp (Embedded Signup).
//
// Cada estabelecimento guarda seu próprio access token da Meta em
// establishments/{id}.whatsapp — sem isso cifrado, qualquer leitura do
// Firestore (bug de regra, backup vazado, etc.) exporia o token em claro,
// dando acesso total à conta de WhatsApp do cliente. Por isso o token nunca
// é gravado como string simples: só o resultado de encryptToken().
//
// AES-256-GCM: cifra + autentica (authTag detecta qualquer adulteração do
// ciphertext). IV aleatório por chamada — nunca reutilizar IV com a mesma
// chave é o requisito de segurança do GCM.
//
// A chave mestra (WHATSAPP_TOKEN_ENC_KEY) vive SOMENTE em variável de
// ambiente — nunca no Firestore, nunca em log, nunca hardcoded, sem
// fallback/default. Deve ser 32 bytes, em base64 (ex.: gerada com
// `openssl rand -base64 32` ou `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";
import type { EncryptedToken } from "@/types";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // recomendado pelo GCM

// Lê e valida a chave mestra a cada chamada — nunca cacheada em módulo nem
// logada. Erro explícito se ausente ou com tamanho/formato inválido (nunca
// cai silenciosamente em uma chave fraca ou fixa).
function loadMasterKey(): Buffer {
  const raw = process.env.WHATSAPP_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "WHATSAPP_TOKEN_ENC_KEY ausente — não é possível cifrar/decifrar tokens do WhatsApp sem a chave mestra.",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("WHATSAPP_TOKEN_ENC_KEY inválida — não foi possível decodificar como base64.");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `WHATSAPP_TOKEN_ENC_KEY com tamanho inválido: esperado ${KEY_BYTES} bytes (AES-256), recebido ${key.length}.`,
    );
  }
  return key;
}

// Cifra um token em claro. IV aleatório a cada chamada; ciphertext, iv e
// authTag são retornados separados (nunca concatenados em uma única string
// "mágica" — cada campo é explícito no schema armazenado).
export function encryptToken(plaintext: string): EncryptedToken {
  if (!plaintext) {
    throw new Error("encryptToken: token vazio.");
  }
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

// Decifra um token previamente cifrado por encryptToken(). Falha explícita
// (nunca retorna string vazia/parcial) se a chave estiver errada ou o
// ciphertext tiver sido adulterado — o authTag do GCM garante isso.
export function decryptToken(encrypted: EncryptedToken): string {
  const key = loadMasterKey();
  const iv = Buffer.from(encrypted.iv, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// ---- PIN de registro do WhatsApp (POST /{phone_number_id}/register) ----
//
// Não é uma credencial da Meta — é a verificação em 2 etapas *daquele número*
// na Cloud API, gerada pela Livia (nunca escolhida pelo estabelecimento, nunca
// um valor fixo compartilhado). Precisa ser recuperável no futuro (um
// re-registro do número exige o MESMO pin já configurado), então é cifrado e
// armazenado — nunca só gerado e descartado, nunca em texto puro.
//
// Reaproveita a mesma infraestrutura AES-256-GCM acima (mesma chave mestra,
// mesmo algoritmo), mas com funções e campo próprios (`pin`, separado de
// `accessToken` no schema) — deixa explícito no código que são usos
// distintos, mesmo compartilhando a implementação.

// PIN aleatório criptograficamente seguro de 6 dígitos (000000–999999).
// randomInt (não Math.random) — mesma classe de aleatoriedade usada para IV.
export function generateRandomPin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function encryptPin(pin: string): EncryptedToken {
  return encryptToken(pin);
}

export function decryptPin(encrypted: EncryptedToken): string {
  return decryptToken(encrypted);
}
