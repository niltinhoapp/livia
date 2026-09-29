import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});
const listMessageTemplates = vi.fn();
vi.mock("@/lib/whatsapp/client", () => ({ listMessageTemplates: (...a: unknown[]) => listMessageTemplates(...a) }));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { handoffTemplateOption, saveHandoffSettings } from "./settings";
import type { Establishment } from "@/types";
import type { WhatsAppTemplate } from "@/lib/whatsapp/client";

const template = (name: string, body: string, over: Partial<WhatsAppTemplate> = {}): WhatsAppTemplate => ({
  id: name, name, language: "pt_BR", status: "APPROVED", category: "UTILITY",
  components: [{ type: "BODY", text: body }], approved: true, senderCompatible: true, ...over,
});
const est = (over: Partial<Establishment> = {}) => ({
  id: "est-a", whatsapp: { wabaId: "w", phoneNumberId: "p", status: "connected" }, ...over,
}) as unknown as Establishment;
const saved = () => fakeDb.col("establishments").get("est-a")?.humanHandoffNotifications;

beforeEach(() => {
  fakeDb.reset();
  vi.clearAllMocks();
  fakeDb.col("establishments").set("est-a", { id: "est-a" });
  listMessageTemplates.mockResolvedValue([
    template("aviso_humano", "Olá! {{1}} pediu atendimento. Abra: {{2}}"),
    template("aviso_simples", "Um cliente pediu atendimento humano."),
    template("tres_vars", "{{1}} {{2}} {{3}}"),
    template("pendente", "{{1}}", { approved: false, status: "PENDING" }),
    template("fora_de_ordem", "{{2}} e {{1}}... {{3}}"),
  ]);
});

describe("templates elegíveis", () => {
  it("só aprovados, compatíveis e com até {{1}}/{{2}} em ordem", () => {
    expect(handoffTemplateOption(template("a", "{{1}} {{2}}"))).toMatchObject({ paramCount: 2 });
    expect(handoffTemplateOption(template("b", "sem variáveis"))).toMatchObject({ paramCount: 0 });
    expect(handoffTemplateOption(template("c", "{{2}}"))).toBeNull();
    expect(handoffTemplateOption(template("d", "{{1}} {{2}} {{3}}"))).toBeNull();
    expect(handoffTemplateOption(template("e", "{{1}}", { approved: false }))).toBeNull();
    expect(handoffTemplateOption(template("f", "{{1}}", { senderCompatible: false }))).toBeNull();
  });
});

describe("salvar configuração", () => {
  it("push sozinho salva sem consultar a Meta", async () => {
    const result = await saveHandoffSettings(est(), { push: true, whatsapp: false });
    expect(result.ok).toBe(true);
    expect(listMessageTemplates).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({ push: true, whatsapp: false, templateName: "" });
  });

  it("WhatsApp: valida o template na Meta e grava a contagem de variáveis", async () => {
    const result = await saveHandoffSettings(est(), { push: true, whatsapp: true, responsiblePhone: "(14) 99999-0000 ", templateName: "aviso_humano", templateLang: "pt_BR" });
    expect(result.ok).toBe(true);
    expect(saved()).toMatchObject({ whatsapp: true, responsiblePhone: "14999990000", templateName: "aviso_humano", templateLang: "pt_BR", templateParamCount: 2 });
  });

  it("recusa template inexistente, não aprovado ou incompatível — nada é presumido", async () => {
    for (const templateName of ["nao_existe", "pendente", "tres_vars", "fora_de_ordem"]) {
      const result = await saveHandoffSettings(est(), { whatsapp: true, responsiblePhone: "5514999990000", templateName });
      expect(result).toMatchObject({ ok: false, status: 400 });
    }
    expect(saved()).toBeUndefined();
  });

  it("recusa sem telefone, sem template, sem WhatsApp conectado e quando a Meta falha", async () => {
    expect(await saveHandoffSettings(est(), { whatsapp: true, responsiblePhone: "123", templateName: "aviso_humano" })).toMatchObject({ ok: false, status: 400 });
    expect(await saveHandoffSettings(est(), { whatsapp: true, responsiblePhone: "5514999990000" })).toMatchObject({ ok: false, status: 400 });
    expect(await saveHandoffSettings(est({ whatsapp: undefined }), { whatsapp: true, responsiblePhone: "5514999990000", templateName: "aviso_humano" })).toMatchObject({ ok: false, status: 409 });
    listMessageTemplates.mockRejectedValueOnce(new Error("meta"));
    expect(await saveHandoffSettings(est(), { whatsapp: true, responsiblePhone: "5514999990000", templateName: "aviso_humano" })).toMatchObject({ ok: false, status: 502 });
    expect(saved()).toBeUndefined();
  });
});
