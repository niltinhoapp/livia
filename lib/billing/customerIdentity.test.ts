import { describe, expect, it, vi } from "vitest";
import {
  normalizeCpfCnpj,
  customerExternalReference,
  resolveOrCreateAsaasCustomer,
  type ResolveCustomerDeps,
} from "./customerIdentity";
import type { AsaasCustomer, AsaasResult } from "./asaas";

function ok<T>(data: T): AsaasResult<T> {
  return { ok: true, data };
}
function httpError(status: number): AsaasResult<never> {
  return { ok: false, error: { kind: "http", status, message: "x" } };
}

function deps(over: Partial<ResolveCustomerDeps["asaas"]> = {}): ResolveCustomerDeps {
  return {
    asaas: {
      findCustomersByExternalReference: vi.fn(async () => ok<AsaasCustomer[]>([])),
      createCustomer: vi.fn(async () => ok<AsaasCustomer>({ id: "cus_new", name: "X" })),
      ...over,
    },
  };
}

const EST = "est_abc-123"; // com hífen: garante que externalReference não quebra

describe("normalizeCpfCnpj", () => {
  it("aceita CPF (11 dígitos) e CNPJ (14), removendo máscara", () => {
    expect(normalizeCpfCnpj("529.982.247-25")).toBe("52998224725");
    expect(normalizeCpfCnpj("11.222.333/0001-81")).toBe("11222333000181");
  });
  it("rejeita formato incompatível", () => {
    expect(normalizeCpfCnpj("123")).toBeNull();
    expect(normalizeCpfCnpj("abc")).toBeNull();
    expect(normalizeCpfCnpj("123456789012")).toBeNull(); // 12 dígitos
  });
});

describe("customerExternalReference", () => {
  it("é o próprio establishmentId (convenção OT-05A)", () => {
    expect(customerExternalReference(EST)).toBe(EST);
  });
});

describe("resolveOrCreateAsaasCustomer", () => {
  it("CPF/CNPJ inválido: rejeita antes de qualquer I/O", async () => {
    const d = deps();
    const r = await resolveOrCreateAsaasCustomer(d, { establishmentId: EST, name: "N", cpfCnpj: "123" });
    expect(r).toEqual({ ok: false, reason: "invalid_cpf_cnpj" });
    expect(d.asaas.findCustomersByExternalReference).not.toHaveBeenCalled();
    expect(d.asaas.createCustomer).not.toHaveBeenCalled();
  });

  it("customer existente é reconciliado, sem criar duplicado", async () => {
    const find = vi.fn(async () => ok<AsaasCustomer[]>([{ id: "cus_existing", name: "N", externalReference: EST }]));
    const create = vi.fn(async () => ok<AsaasCustomer>({ id: "cus_new", name: "N" }));
    const r = await resolveOrCreateAsaasCustomer(deps({ findCustomersByExternalReference: find, createCustomer: create }), {
      establishmentId: EST,
      name: "N",
      cpfCnpj: "52998224725",
    });
    expect(r).toEqual({ ok: true, externalCustomerId: "cus_existing", outcome: "reconciled" });
    expect(create).not.toHaveBeenCalled();
  });

  it("customer ausente: cria pelo externalReference do establishment correto", async () => {
    const create = vi.fn(async () => ok<AsaasCustomer>({ id: "cus_created", name: "N", externalReference: EST }));
    const r = await resolveOrCreateAsaasCustomer(deps({ createCustomer: create }), {
      establishmentId: EST,
      name: "N",
      cpfCnpj: "11.222.333/0001-81",
    });
    expect(r).toEqual({ ok: true, externalCustomerId: "cus_created", outcome: "created" });
    // externalReference determinístico = establishmentId; cpfCnpj normalizado
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ externalReference: EST, cpfCnpj: "11222333000181" }),
    );
  });

  it("repetição converge para o mesmo customer (idempotente por externalReference)", async () => {
    // 1ª: não existe -> cria. 2ª: já existe -> reconcilia o mesmo id.
    const store: AsaasCustomer[] = [];
    const find = vi.fn(async () => ok<AsaasCustomer[]>([...store]));
    const create = vi.fn(async () => {
      const c = { id: "cus_1", name: "N", externalReference: EST };
      store.push(c);
      return ok<AsaasCustomer>(c);
    });
    const d = deps({ findCustomersByExternalReference: find, createCustomer: create });
    const r1 = await resolveOrCreateAsaasCustomer(d, { establishmentId: EST, name: "N", cpfCnpj: "52998224725" });
    const r2 = await resolveOrCreateAsaasCustomer(d, { establishmentId: EST, name: "N", cpfCnpj: "52998224725" });
    expect(r1).toMatchObject({ externalCustomerId: "cus_1", outcome: "created" });
    expect(r2).toMatchObject({ externalCustomerId: "cus_1", outcome: "reconciled" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("falha de lookup não tenta criar (evita duplicado às cegas)", async () => {
    const create = vi.fn(async () => ok<AsaasCustomer>({ id: "x", name: "N" }));
    const r = await resolveOrCreateAsaasCustomer(
      deps({ findCustomersByExternalReference: vi.fn(async () => httpError(500)), createCustomer: create }),
      { establishmentId: EST, name: "N", cpfCnpj: "52998224725" },
    );
    expect(r).toEqual({ ok: false, reason: "lookup_failed" });
    expect(create).not.toHaveBeenCalled();
  });

  it("não retorna CPF/CNPJ na resposta", async () => {
    const r = await resolveOrCreateAsaasCustomer(deps(), { establishmentId: EST, name: "N", cpfCnpj: "52998224725" });
    expect(JSON.stringify(r)).not.toContain("52998224725");
  });
});
