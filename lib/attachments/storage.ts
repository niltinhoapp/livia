import { createHash } from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import { firebaseAdminApp } from "@/lib/firebase/admin";
import type { AttachmentType, MessageAttachment } from "@/types";

export type AttachmentStorageErrorCode =
  | "storage_not_configured"
  | "invalid_storage_scope"
  | "storage_write_failed"
  | "storage_read_failed";

export class AttachmentStorageError extends Error {
  constructor(public readonly code: AttachmentStorageErrorCode) {
    super(code);
    this.name = "AttachmentStorageError";
  }
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new AttachmentStorageError("invalid_storage_scope");
  return value;
}

export function sanitizeAttachmentFilename(value: string | undefined, mimeType: string): string {
  const basename = value
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\uD800-\uDFFF]/g, "_")
    .trim();
  const fallback = `anexo${EXTENSION_BY_MIME[mimeType] ?? ""}`;
  return (basename || fallback).slice(0, 160);
}

function bucket() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (!bucketName) throw new AttachmentStorageError("storage_not_configured");
  return getStorage(firebaseAdminApp).bucket(bucketName);
}

function attachmentIdentity(waMessageId: string, metaMediaId: string): string {
  return createHash("sha256").update(`${waMessageId}\0${metaMediaId}`).digest("hex").slice(0, 32);
}

function storagePrefix(establishmentId: string, conversationId: string): string {
  return `establishments/${safeSegment(establishmentId)}/conversations/${safeSegment(conversationId)}/attachments/`;
}

export async function storeConversationAttachment(input: {
  establishmentId: string;
  conversationId: string;
  waMessageId: string;
  metaMediaId: string;
  type: AttachmentType;
  mimeType: string;
  filename?: string;
  bytes: Uint8Array;
  createdAt?: number;
}): Promise<MessageAttachment> {
  const id = attachmentIdentity(input.waMessageId, input.metaMediaId);
  const filename = sanitizeAttachmentFilename(input.filename, input.mimeType);
  const storageRef = `${storagePrefix(input.establishmentId, input.conversationId)}${id}${EXTENSION_BY_MIME[input.mimeType] ?? ""}`;
  const file = bucket().file(storageRef);

  try {
    const [exists] = await file.exists();
    if (!exists) {
      await file.save(Buffer.from(input.bytes), {
        resumable: false,
        validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: input.mimeType,
          cacheControl: "private, no-store, max-age=0",
          metadata: {
            establishmentId: input.establishmentId,
            conversationId: input.conversationId,
            waMessageId: input.waMessageId,
            attachmentId: id,
          },
        },
      });
    }
  } catch (err) {
    const code = (err as { code?: number | string } | null)?.code;
    // Uma corrida com o mesmo wamid pode vencer entre exists() e save(). A
    // precondition impede overwrite; o objeto determinístico já existente é
    // exatamente o resultado idempotente desejado.
    if (code !== 412 && code !== "412") throw new AttachmentStorageError("storage_write_failed");
  }

  return {
    id,
    type: input.type,
    mimeType: input.mimeType,
    filename,
    sizeBytes: input.bytes.byteLength,
    metaMediaId: input.metaMediaId,
    storageRef,
    createdAt: input.createdAt ?? Date.now(),
  };
}

function assertScopedStorageRef(establishmentId: string, conversationId: string, storageRef: string): void {
  if (!storageRef.startsWith(storagePrefix(establishmentId, conversationId))) {
    throw new AttachmentStorageError("invalid_storage_scope");
  }
  const remainder = storageRef.slice(storagePrefix(establishmentId, conversationId).length);
  if (!/^[a-f0-9]{32}(?:\.[a-z0-9]{1,5})?$/.test(remainder)) {
    throw new AttachmentStorageError("invalid_storage_scope");
  }
}

export async function readConversationAttachment(
  establishmentId: string,
  conversationId: string,
  storageRef: string,
): Promise<Uint8Array> {
  assertScopedStorageRef(establishmentId, conversationId, storageRef);
  try {
    const [bytes] = await bucket().file(storageRef).download();
    return new Uint8Array(bytes);
  } catch {
    throw new AttachmentStorageError("storage_read_failed");
  }
}

export async function deleteConversationAttachment(
  establishmentId: string,
  conversationId: string,
  storageRef: string,
): Promise<void> {
  assertScopedStorageRef(establishmentId, conversationId, storageRef);
  await bucket().file(storageRef).delete({ ignoreNotFound: true }).catch(() => undefined);
}
