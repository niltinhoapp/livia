import { describe, expect, it } from "vitest";
import { resolveCampaignTemplateParams, templateParameterBindingsAreValid, templateParameterIndexes } from "@/lib/campaignTemplates";

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
});
