// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CustomersPage from "./page";

const legacyCustomer = {
  phone: "5514996447132", establishmentId: "est-a", name: "Contato legado",
  preferredProfessional: null, preferredTime: null, frequentAddress: null, lastService: null,
  lastIntent: null, notes: null, lastInteractionAt: 1, createdAt: 1, updatedAt: 1,
};
const eligibleCustomer = { ...legacyCustomer, marketingStatus: "eligible" as const };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Clientes — contatos para campanhas", () => {
  it("não envia declaração de consentimento sem confirmação explícita", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ customers: [legacyCustomer] }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomersPage />);
    await waitFor(() => expect(screen.getByText("Contato legado")).toBeTruthy());
    expect(screen.getByText("Sem consentimento")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /adicionar contatos/i }));
    const submit = screen.getByRole("button", { name: /adicionar contatos elegíveis/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("envia opt-in somente após confirmação e atualiza o status elegível", async () => {
    let customersReads = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/customers/import") return Promise.resolve({ ok: true, json: async () => ({ result: { created: 1, eligible: 1, protected: 1 } }) });
      customersReads++;
      return Promise.resolve({ ok: true, json: async () => ({ customers: customersReads > 1 ? [eligibleCustomer] : [legacyCustomer] }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomersPage />);
    await waitFor(() => expect(screen.getByText("Contato legado")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /adicionar contatos/i }));
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "Contato controlado" } });
    fireEvent.change(inputs[1], { target: { value: "(14) 99644-7132" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /adicionar contatos elegíveis/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/customers/import", expect.objectContaining({ method: "POST" })));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/customers/import")!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      contacts: [{ name: "Contato controlado", phone: "(14) 99644-7132" }],
      declaration: { confirmedMarketingOptIn: true, source: "whatsapp" },
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/1 protegido\(s\).*mantido\(s\) sem alteração/i));
    await waitFor(() => expect(screen.getByText("Elegível")).toBeTruthy());
  });
});
