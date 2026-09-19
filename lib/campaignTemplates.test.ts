import { describe, expect, it } from "vitest";
import { campaignTemplateSnapshot, resolveCampaignTemplateParams, templateBodyExampleValues, templateParameterBindingsAreValid, templateParameterIndexes } from "@/lib/campaignTemplates";

const components = [{ type: "BODY", text: "Olá {{1}}, desconto {{2}}, cupom {{3}}" }];

describe("variáveis de templates de campanha", () => {
  it("extrai índices em ordem e sem duplicação", () => {
    expect(templateParameterIndexes([...components, { type: "BODY", text: "Repete {{2}}" }])).toEqual([1, 2, 3]);
  });

  it("exige binding para cada variável", () => {
    expect(templateParameterBindingsAreValid(components, [
      { index: 1, source: "customer_name" },
      { index: 2, source: "fixed", value: "20%" },
    ])).toBe(false);
  });

  it("resolve nome por destinatário e valores fixos", () => {
    expect(resolveCampaignTemplateParams({
      name: "cupom", languageCode: "pt_BR", components,
      parameterBindings: [
        { index: 1, source: "customer_name" },
        { index: 2, source: "fixed", value: "20%" },
        { index: 3, source: "fixed", value: "LIVIA20" },
      ],
    }, "Ana")).toEqual(["Ana", "20%", "LIVIA20"]);
  });

  it("carrega os valores posicionais usados na aprovação da Meta", () => {
    expect(templateBodyExampleValues([{
      type: "BODY",
      example: { body_text: [["Maria", "LIVIA20", "20%"]] },
    }])).toEqual({ 1: "Maria", 2: "LIVIA20", 3: "20%" });
  });

  it("remove exemplos com arrays aninhados antes de persistir no Firestore", () => {
    const snapshot = campaignTemplateSnapshot({
      id: "tpl-1", name: "cupom", language: "pt_BR", status: "APPROVED",
      approved: true, senderCompatible: true,
      components: [{ type: "BODY", text: "Olá {{1}}, use {{2}}", example: { body_text: [["Maria", "LIVIA20"]] } }],
    }, [
      { index: 1, source: "customer_name" },
      { index: 2, source: "fixed", value: "LIVIA20" },
    ]);

    expect(snapshot.components).toEqual([{ type: "BODY", text: "Olá {{1}}, use {{2}}" }]);
    expect(JSON.stringify(snapshot)).not.toContain("body_text");
  });
});
