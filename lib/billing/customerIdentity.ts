// Identidade de cobrança Asaas para o fluxo REAL de produto (OT-07E0).
// Prepara o passo que faltava antes da assinatura (OT-07E1): resolver ou
// criar o customer Asaas do estabelecimento autenticado, de forma idempotente,
// reutilizando EXCLUSIVAMENTE o que o client já oferece
// (findCustomersByExternalReference + createCustomer) e o externalReference
// determinístico. Não cria assinatura, não cria cobrança, não chama Asaas de
// produção — a chamada real é feita pelo endpoint futuro com deps injetadas.
//
// CPF/CNPJ NUNCA é persistido pela Lívia: fica só no Asaas. O único vínculo
// que o produto precisa guardar localmente é o externalCustomerId
// (ver lib/repo.ts:linkEstablishmentBilling). CPF/CNPJ também nunca é logado.
import type { AsaasClient } from "./asaas";

// Convenção OT-05A: o externalReference do CUSTOMER é o próprio
// establishmentId (não confundir com o externalReference da SUBSCRIPTION,
// que é `livia:subscription:{id}:{gen}`). Isso amarra o customer
// inequivocamente ao tenant autenticado e permite reconciliação sem duplicar.
export function customerExternalReference(establishmentId: string): string {
  return establishmentId;
}

// Normaliza para somente dígitos e valida o formato (11 = CPF, 14 = CNPJ).
// Validação de formato, não de dígito verificador — não inventamos regras
// além do que o Asaas exige para aceitar o customer. Retorna null se o
// formato for incompatível, para o chamador rejeitar antes de qualquer I/O.
export function normalizeCpfCnpj(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 || digits.length === 14 ? digits : null;
}

export type ResolveCustomerDeps = {
  asaas: Pick<AsaasClient, "findCustomersByExternalReference" | "createCustomer">;
};

export interface ResolveCustomerInput {
  establishmentId: string;
  name: string;
  cpfCnpj: string;
}

export type ResolveCustomerResult =
  | { ok: true; externalCustomerId: string; outcome: "reconciled" | "created" }
  | { ok: false; reason: "invalid_cpf_cnpj" | "lookup_failed" | "create_failed" };

// Idempotência por externalReference (a reconciliação que o próprio client
// documenta): consulta primeiro; se já existe um customer compatível para
// este establishment, reutiliza — nunca cria um segundo. Só cria quando a
// consulta não encontrou nenhum. Repetições da mesma chamada convergem para
// o mesmo customer.
export async function resolveOrCreateAsaasCustomer(
  deps: ResolveCustomerDeps,
  input: ResolveCustomerInput,
): Promise<ResolveCustomerResult> {
  const cpfCnpj = normalizeCpfCnpj(input.cpfCnpj);
  if (!cpfCnpj) return { ok: false, reason: "invalid_cpf_cnpj" };

  const externalReference = customerExternalReference(input.establishmentId);

  const existing = await deps.asaas.findCustomersByExternalReference(externalReference);
  if (!existing.ok) return { ok: false, reason: "lookup_failed" };

  const match = existing.data.find(
    (c) => c.externalReference === undefined || c.externalReference === externalReference,
  );
  if (match) return { ok: true, externalCustomerId: match.id, outcome: "reconciled" };

  const created = await deps.asaas.createCustomer({
    name: input.name,
    cpfCnpj,
    externalReference,
  });
  if (!created.ok) return { ok: false, reason: "create_failed" };

  return { ok: true, externalCustomerId: created.data.id, outcome: "created" };
}
