import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { appendMessage, listMessages } from "@/lib/repo";

beforeEach(() => fakeDb.reset());

async function criarConversa() {
  await fakeDb.collection("establishments").doc("est").collection("conversations").doc("conv").set({
    id: "conv", lastMessageAt: 0,
  });
}

describe("appendMessage V2", () => {
  it("mantém a chamada legada e retorna id e at", async () => {
    await criarConversa();
    const result = await appendMessage("est", "conv", "customer", "olá", "wamid.text");
    expect(result.id).toBeTruthy();
    expect(result.at).toEqual(expect.any(Number));
    await expect(listMessages("est", "conv")).resolves.toEqual([
      expect.objectContaining({ id: result.id, role: "customer", text: "olá", waMessageId: "wamid.text" }),
    ]);
  });

  it("persiste metadata V2 opcional sem mudar o documento textual", async () => {
    await criarConversa();
    await appendMessage("est", "conv", "customer", "[Áudio recebido]", "wamid.audio", {
      kind: "audio",
      phoneNumberId: "pn_1",
      media: { metaMediaId: "media_1", mimeType: "audio/ogg", voice: true },
    });
    await expect(listMessages("est", "conv")).resolves.toEqual([
      expect.objectContaining({
        kind: "audio", phoneNumberId: "pn_1", text: "[Áudio recebido]",
        media: { metaMediaId: "media_1", mimeType: "audio/ogg", voice: true },
      }),
    ]);
  });
});
