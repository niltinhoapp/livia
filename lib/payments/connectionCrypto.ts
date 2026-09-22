import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptedToken } from "@/types";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function key(): Buffer {
  const raw = process.env.PAYMENT_CONNECTION_TOKEN_ENC_KEY;
  if (!raw) throw new Error("PAYMENT_CONNECTION_TOKEN_ENC_KEY ausente.");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) throw new Error("PAYMENT_CONNECTION_TOKEN_ENC_KEY inválida.");
  return decoded;
}

export function encryptPaymentConnectionSecret(value: string): EncryptedToken {
  if (!value) throw new Error("Segredo de conexão vazio.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

export function decryptPaymentConnectionSecret(value: EncryptedToken): string {
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
