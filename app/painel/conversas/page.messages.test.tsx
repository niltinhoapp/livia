// @vitest-environment jsdom
//
// Fix #1 da auditoria de consumo do Firestore (03/09/2026): ConversationDetail
// rebuscava até 100 mensagens a cada 15s, MESMO sem mensagem nova — a maior
// fonte isolada de leitura do dia. Agora só rebusca quando `conversation.id`
// ou `conversation.lastMessageAt` mudam, ou quando uma ação local (assumir/
// devolver) sabidamente altera a conversa.
//
// Único arquivo .test.tsx do projeto — usa jsdom (via pragma acima) e
// @testing-library/react, ambos adicionados só para este teste (ver
// vitest.config.mts: o default de todo o resto continua "node").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConversationDetail } from "./ConversationDetail";
import type { Conversation } from "@/types";

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    establishmentId: "demo",
    contactPhone: "5514996447132",
    contactName: "Nilton",
    status: "bot",
    lastMessageAt: 1000,
    createdAt: 1,
    ...over,
  };
}

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

function messagesEndpointBody(status: Conversation["status"] = "bot") {
  return { messages: [{ id: "m1", role: "bot", text: "oi", at: 1 }], conversation: { status } };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/conversations/") && (!init || init.method === undefined)) {
      return jsonResponse(messagesEndpointBody());
    }
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { action: "assume" | "return" };
      return jsonResponse({ ok: true, status: body.action === "assume" ? "human" : "bot" });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function getMessagesCalls() {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).startsWith("/api/conversations/") && (init === undefined || init.method === undefined),
  );
}

describe("A — lastMessageAt sem mudança não refaz fetch das mensagens", () => {
  it("re-renderizar com a MESMA conversa (mesmo lastMessageAt) não busca de novo", async () => {
    const conv = conversation();
    const { rerender } = render(
      <ConversationDetail conversation={conv} onBack={() => {}} onStatusChanged={() => {}} />,
    );
    await waitFor(() => expect(getMessagesCalls()).toHaveLength(1));

    // Simula o poll da LISTA (a cada 15s) devolvendo a mesma conversa, sem
    // nenhuma mensagem nova — é exatamente o caso que gerava leitura à toa.
    rerender(<ConversationDetail conversation={conversation()} onBack={() => {}} onStatusChanged={() => {}} />);

    // Dá tempo pra um efeito indevido rodar, se houvesse algum.
    await new Promise((r) => setTimeout(r, 10));
    expect(getMessagesCalls()).toHaveLength(1);
  });
});

describe("B — lastMessageAt mudou: refaz fetch e atualiza o histórico", () => {
  it("nova mensagem no poll da lista dispara nova busca", async () => {
    const conv = conversation({ lastMessageAt: 1000 });
    const { rerender } = render(
      <ConversationDetail conversation={conv} onBack={() => {}} onStatusChanged={() => {}} />,
    );
    await waitFor(() => expect(getMessagesCalls()).toHaveLength(1));

    fetchMock.mockImplementationOnce(() =>
      jsonResponse({ messages: [{ id: "m2", role: "customer", text: "nova msg", at: 2 }], conversation: { status: "bot" } }),
    );
    rerender(
      <ConversationDetail conversation={conversation({ lastMessageAt: 2000 })} onBack={() => {}} onStatusChanged={() => {}} />,
    );

    await waitFor(() => expect(getMessagesCalls()).toHaveLength(2));
    expect(await screen.findByText("nova msg")).toBeTruthy();
  });
});

describe("C — troca de conversa carrega imediatamente o histórico correto", () => {
  it("mudar conversation.id busca a nova conversa de imediato, mesmo com lastMessageAt igual", async () => {
    const convA = conversation({ id: "conv-A", lastMessageAt: 1000 });
    const { rerender } = render(
      <ConversationDetail conversation={convA} onBack={() => {}} onStatusChanged={() => {}} />,
    );
    await waitFor(() => expect(getMessagesCalls()).toHaveLength(1));
    expect(getMessagesCalls()[0]![0]).toBe("/api/conversations/conv-A");

    const convB = conversation({ id: "conv-B", lastMessageAt: 1000 }); // mesmo lastMessageAt, OUTRA conversa
    rerender(<ConversationDetail conversation={convB} onBack={() => {}} onStatusChanged={() => {}} />);

    await waitFor(() => expect(getMessagesCalls()).toHaveLength(2));
    expect(getMessagesCalls()[1]![0]).toBe("/api/conversations/conv-B");
  });
});

describe("D — ação local (assumir/devolver) atualiza sem esperar o polling externo", () => {
  it("clicar em 'Assumir conversa' rebusca as mensagens imediatamente, sem lastMessageAt mudar", async () => {
    const conv = conversation({ status: "bot" });
    render(<ConversationDetail conversation={conv} onBack={() => {}} onStatusChanged={() => {}} />);
    await waitFor(() => expect(getMessagesCalls()).toHaveLength(1));

    fireEvent.click(screen.getByText("Assumir conversa"));

    await waitFor(() => expect(getMessagesCalls()).toHaveLength(2));
    // A ação em si (PATCH) também deve ter acontecido.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
  });
});
