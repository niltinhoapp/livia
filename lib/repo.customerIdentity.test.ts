// Regressão: o mesmo telefone aparecia com nomes diferentes no CRM
// ("niltinho" numa conversa, "Nilton" noutra). Telefone é o identificador
// único do cliente (normalizePhone -> id do documento em customers/); uma
// vez que o nome já está cadastrado, uma variação vinda de uma mensagem
// nova nunca pode substituí-lo.
//
// A regra vive em upsertCustomerProfile (lib/repo.ts) — a única função que
// grava o perfil — em vez de depender de cada chamador repetir o cuidado.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { getCustomerProfile, upsertCustomerProfile } from "@/lib/repo";

const EST = "demo";

beforeEach(() => {
  fakeDb.reset?.();
});

describe("identidade do cliente por telefone — nome não é sobrescrito", () => {
  it("1. telefone novo + nome 'Nilton' -> cria cliente 'Nilton'", async () => {
    await upsertCustomerProfile(EST, "5514996447132", { name: "Nilton" });

    const profile = await getCustomerProfile(EST, "5514996447132");
    expect(profile?.name).toBe("Nilton");
  });

  it("2. mesmo telefone + nome 'niltinho' numa mensagem seguinte -> continua 'Nilton'", async () => {
    await upsertCustomerProfile(EST, "5514996447132", { name: "Nilton" });

    await upsertCustomerProfile(EST, "5514996447132", { name: "niltinho" });

    const profile = await getCustomerProfile(EST, "5514996447132");
    expect(profile?.name).toBe("Nilton");
  });

  it("3. mesmo telefone em uma 'nova conversa' (nova chamada, sem relação com a anterior) -> continua 'Nilton'", async () => {
    await upsertCustomerProfile(EST, "5514996447132", { name: "Nilton" });

    // Simula uma conversa nova chegando com o push name mudado no WhatsApp.
    await upsertCustomerProfile(EST, "5514996447132", { name: "niltinho", lastIntent: "general_question" });

    const profile = await getCustomerProfile(EST, "5514996447132");
    expect(profile?.name).toBe("Nilton");
    // Outros campos do patch continuam sendo aplicados normalmente — só o
    // nome é protegido.
    expect(profile?.lastIntent).toBe("general_question");
  });

  it("4. mesmo telefone gerando outra oportunidade/atualização -> continua 'Nilton'", async () => {
    await upsertCustomerProfile(EST, "5514996447132", { name: "Nilton" });

    await upsertCustomerProfile(EST, "5514996447132", { name: "niltinho", lastService: "Avaliação" });
    await upsertCustomerProfile(EST, "5514996447132", { name: "Nilto", lastService: "Limpeza" });

    const profile = await getCustomerProfile(EST, "5514996447132");
    expect(profile?.name).toBe("Nilton");
    expect(profile?.lastService).toBe("Limpeza");
  });

  it("5. telefone diferente + nome 'niltinho' -> cria outro cliente normalmente, isolado do primeiro", async () => {
    await upsertCustomerProfile(EST, "5514996447132", { name: "Nilton" });

    await upsertCustomerProfile(EST, "5514999998888", { name: "niltinho" });

    const a = await getCustomerProfile(EST, "5514996447132");
    const b = await getCustomerProfile(EST, "5514999998888");
    expect(a?.name).toBe("Nilton");
    expect(b?.name).toBe("niltinho");
  });

  it("preenche o nome quando o cadastro existente ainda não tem nome (não é 'sobrescrever', é completar um dado ausente)", async () => {
    // Perfil criado sem nome (ex.: só preferências registradas antes de
    // sabermos o nome do cliente).
    await upsertCustomerProfile(EST, "5514996447132", { preferredTime: "manhã" });
    expect((await getCustomerProfile(EST, "5514996447132"))?.name).toBeNull();

    await upsertCustomerProfile(EST, "5514996447132", { name: "Nilton" });

    const profile = await getCustomerProfile(EST, "5514996447132");
    expect(profile?.name).toBe("Nilton");
    expect(profile?.preferredTime).toBe("manhã");
  });

  it("números equivalentes (com/sem DDI) resolvem para o mesmo documento e preservam o nome", async () => {
    await upsertCustomerProfile(EST, "5514996447132", { name: "Nilton" });

    // Mesmo número, digitado sem o 55 (ex.: painel) — normalizePhone
    // resolve para o mesmo id de documento.
    await upsertCustomerProfile(EST, "14996447132", { name: "niltinho" });

    const profile = await getCustomerProfile(EST, "5514996447132");
    expect(profile?.name).toBe("Nilton");
  });

  it("6. nenhuma funcionalidade existente foi alterada: patch sem name continua atualizando os demais campos", async () => {
    await upsertCustomerProfile(EST, "5514996447132", { name: "Nilton" });

    await upsertCustomerProfile(EST, "5514996447132", {
      preferredProfessional: "Dra. Ana",
      preferredTime: "tarde",
      frequentAddress: "Rua X",
      lastService: "Avaliação",
      lastIntent: "schedule_appointment",
    });

    const profile = await getCustomerProfile(EST, "5514996447132");
    expect(profile).toMatchObject({
      name: "Nilton",
      preferredProfessional: "Dra. Ana",
      preferredTime: "tarde",
      frequentAddress: "Rua X",
      lastService: "Avaliação",
      lastIntent: "schedule_appointment",
    });
  });
});
