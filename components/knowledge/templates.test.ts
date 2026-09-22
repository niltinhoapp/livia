import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_TEMPLATES,
  suggestedTemplateFor,
  mergeTemplateIntoKnowledge,
  type KnowledgeFormData,
} from "./templates";
import { ESTABLISHMENT_TYPE_LABELS } from "@/components/lib/labels";
import type { EstablishmentType } from "@/types";

describe("KNOWLEDGE_TEMPLATES — Modelos de Conhecimento", () => {
  it("contém os 4 novos segmentos da vertical Alimentação", () => {
    const foodIds = ["restaurante", "lanchonete", "pizzaria", "hamburgueria"];
    for (const id of foodIds) {
      const template = KNOWLEDGE_TEMPLATES.find((t) => t.id === id);
      expect(template, `Modelo com id "${id}" deve existir`).toBeDefined();
      expect(template!.matchesTypes).toContain(id as EstablishmentType);
      expect(template!.label).toBe(ESTABLISHMENT_TYPE_LABELS[id as EstablishmentType]);
    }
  });

  it("mantém todos os segmentos anteriores intactos e funcionais", () => {
    const previousIds = [
      "odontologica",
      "salao_barbearia",
      "pet_shop",
      "oficina_mecanica",
      "academia",
      "imobiliaria",
    ];
    for (const id of previousIds) {
      const template = KNOWLEDGE_TEMPLATES.find((t) => t.id === id);
      expect(template, `Modelo legado com id "${id}" deve existir`).toBeDefined();
      expect(template!.services.length).toBeGreaterThan(0);
    }
    expect(KNOWLEDGE_TEMPLATES.length).toBe(10);
  });

  it("todos os modelos possuem campos textuais preenchidos com orientações relevantes", () => {
    for (const t of KNOWLEDGE_TEMPLATES) {
      expect(t.id.trim()).not.toBe("");
      expect(t.label.trim()).not.toBe("");
      expect(t.matchesTypes.length).toBeGreaterThan(0);
      expect(t.about.trim().length).toBeGreaterThan(20);
      expect(t.paymentMethods.trim().length).toBeGreaterThan(5);
      expect(t.importantInfo.trim().length).toBeGreaterThan(10);
      expect(t.toneGuidelines.trim().length).toBeGreaterThan(10);
      expect(t.prohibitions.trim().length).toBeGreaterThan(10);
      expect(t.handoffTriggers.trim().length).toBeGreaterThan(10);
    }
  });

  describe("suggestedTemplateFor — sugestão automática por tipo de estabelecimento", () => {
    it("sugere os modelos corretos para os 4 tipos de alimentação", () => {
      expect(suggestedTemplateFor("restaurante")?.id).toBe("restaurante");
      expect(suggestedTemplateFor("lanchonete")?.id).toBe("lanchonete");
      expect(suggestedTemplateFor("pizzaria")?.id).toBe("pizzaria");
      expect(suggestedTemplateFor("hamburgueria")?.id).toBe("hamburgueria");
    });

    it("sugere os modelos corretos para tipos legados", () => {
      expect(suggestedTemplateFor("odonto")?.id).toBe("odontologica");
      expect(suggestedTemplateFor("clinica")?.id).toBe("odontologica");
      expect(suggestedTemplateFor("salao")?.id).toBe("salao_barbearia");
      expect(suggestedTemplateFor("estetica")?.id).toBe("salao_barbearia");
      expect(suggestedTemplateFor("pet")?.id).toBe("pet_shop");
      expect(suggestedTemplateFor("oficina")?.id).toBe("oficina_mecanica");
      expect(suggestedTemplateFor("academia")?.id).toBe("academia");
      expect(suggestedTemplateFor("imobiliaria")?.id).toBe("imobiliaria");
    });

    it("retorna null para tipos genéricos como 'outro'", () => {
      expect(suggestedTemplateFor("outro")).toBeNull();
    });
  });

  describe("mergeTemplateIntoKnowledge — preenchimento sem sobrescrita", () => {
    const emptyCurrent: KnowledgeFormData = {
      about: "",
      services: [],
      paymentMethods: "",
      importantInfo: "",
      toneGuidelines: "",
      prohibitions: "",
      handoffTriggers: "",
    };

    const templatePizzaria = KNOWLEDGE_TEMPLATES.find((t) => t.id === "pizzaria")!;

    it("preenche todos os campos textuais quando o formulário está completamente vazio", () => {
      const result = mergeTemplateIntoKnowledge(emptyCurrent, templatePizzaria);

      expect(result.about).toBe(templatePizzaria.about);
      expect(result.services).toEqual(templatePizzaria.services);
      expect(result.paymentMethods).toBe(templatePizzaria.paymentMethods);
      expect(result.importantInfo).toBe(templatePizzaria.importantInfo);
      expect(result.toneGuidelines).toBe(templatePizzaria.toneGuidelines);
      expect(result.prohibitions).toBe(templatePizzaria.prohibitions);
      expect(result.handoffTriggers).toBe(templatePizzaria.handoffTriggers);
    });

    it("preenche campos com apenas espaços em branco como se estivessem vazios", () => {
      const whitespaceCurrent: KnowledgeFormData = {
        about: "   ",
        services: [],
        paymentMethods: "  \n  ",
        importantInfo: "",
        toneGuidelines: "",
        prohibitions: " ",
        handoffTriggers: "",
      };

      const result = mergeTemplateIntoKnowledge(whitespaceCurrent, templatePizzaria);
      expect(result.about).toBe(templatePizzaria.about);
      expect(result.paymentMethods).toBe(templatePizzaria.paymentMethods);
      expect(result.prohibitions).toBe(templatePizzaria.prohibitions);
    });

    it("NUNCA sobrescreve conteúdo já existente cadastrado pelo comerciante", () => {
      const customCurrent: KnowledgeFormData = {
        about: "Minha Pizzaria do Zé existente e consolidada",
        services: [{ name: "Pizza Customizada", priceText: "R$ 80", durationText: null, description: "Exclusiva" }],
        paymentMethods: "Somente dinheiro e Pix",
        importantInfo: "Não entregamos após as 23h",
        toneGuidelines: "Fale bem caipira e direto",
        prohibitions: "Não aceite cheque",
        handoffTriggers: "Quando chamar o Zé",
      };

      const result = mergeTemplateIntoKnowledge(customCurrent, templatePizzaria);

      expect(result.about).toBe("Minha Pizzaria do Zé existente e consolidada");
      expect(result.services).toEqual(customCurrent.services);
      expect(result.paymentMethods).toBe("Somente dinheiro e Pix");
      expect(result.importantInfo).toBe("Não entregamos após as 23h");
      expect(result.toneGuidelines).toBe("Fale bem caipira e direto");
      expect(result.prohibitions).toBe("Não aceite cheque");
      expect(result.handoffTriggers).toBe("Quando chamar o Zé");
    });

    it("preenche SOMENTE os campos que estiverem vazios e preserva os já preenchidos", () => {
      const partiallyFilled: KnowledgeFormData = {
        about: "Hamburgueria Artesanal da Vila",
        services: [{ name: "Meu Burger", priceText: "R$ 30", durationText: null, description: null }], // preenchido -> deve manter
        paymentMethods: "Pix e Cartão", // preenchido -> deve manter
        importantInfo: "", // vazio -> deve preencher
        toneGuidelines: "Tom amigável", // preenchido -> deve manter
        prohibitions: "", // vazio -> deve preencher
        handoffTriggers: "", // vazio -> deve preencher
      };

      const templateBurger = KNOWLEDGE_TEMPLATES.find((t) => t.id === "hamburgueria")!;
      const result = mergeTemplateIntoKnowledge(partiallyFilled, templateBurger);

      // Campos que estavam preenchidos permanecem intactos
      expect(result.about).toBe("Hamburgueria Artesanal da Vila");
      expect(result.services).toEqual(partiallyFilled.services);
      expect(result.paymentMethods).toBe("Pix e Cartão");
      expect(result.toneGuidelines).toBe("Tom amigável");

      // Campos vazios recebem o conteúdo do modelo
      expect(result.importantInfo).toBe(templateBurger.importantInfo);
      expect(result.prohibitions).toBe(templateBurger.prohibitions);
      expect(result.handoffTriggers).toBe(templateBurger.handoffTriggers);
    });
  });

  describe("Vertical Alimentação — isolamento de dados operacionais e ausência de dados fictícios", () => {
    const foodTemplates = KNOWLEDGE_TEMPLATES.filter((t) =>
      ["restaurante", "lanchonete", "pizzaria", "hamburgueria"].includes(t.id)
    );

    it("modelos de alimentação NÃO contêm lista de serviços/preços fictícios (deve ser vazia)", () => {
      for (const t of foodTemplates) {
        expect(
          t.services,
          `Template ${t.id} não deve injetar serviços fictícios, cardápio é a fonte de verdade`
        ).toEqual([]);
      }
    });

    it("modelos de alimentação NÃO contêm preços fixos ou valores monetários inventados (R$)", () => {
      for (const t of foodTemplates) {
        const fullContent = `${t.about} ${t.paymentMethods} ${t.importantInfo} ${t.toneGuidelines} ${t.prohibitions} ${t.handoffTriggers}`;
        expect(fullContent).not.toMatch(/R\$\s*\d+/i);
        expect(fullContent).not.toMatch(/R\$\d+/i);
      }
    });

    it("modelos de alimentação NÃO contêm tempos fixos de entrega fictícios", () => {
      for (const t of foodTemplates) {
        const fullContent = `${t.about} ${t.paymentMethods} ${t.importantInfo}`;
        // Não deve ter durações específicas como "40 a 60 minutos", "30 a 50", etc.
        expect(fullContent).not.toMatch(/\d+\s*(a|-|às)\s*\d+\s*minutos?/i);
      }
    });

    it("modelos de alimentação NÃO contêm regras operacionais inventadas (limite de sabores, ponto da carne)", () => {
      for (const t of foodTemplates) {
        const fullContent = `${t.about} ${t.importantInfo} ${t.prohibitions}`;
        expect(fullContent).not.toMatch(/até \d+ sabores/i);
        expect(fullContent).not.toMatch(/ponto padrão da carne/i);
        expect(fullContent).not.toMatch(/ao ponto \(bem suculento\)/i);
      }
    });

    it("modelos de alimentação NÃO fixam marcas específicas de vales-refeição como dado factual", () => {
      for (const t of foodTemplates) {
        const fullContent = `${t.paymentMethods} ${t.importantInfo}`;
        expect(fullContent).not.toMatch(/alelo/i);
        expect(fullContent).not.toMatch(/sodexo/i);
        expect(fullContent).not.toMatch(/ticket/i);
      }
    });

    it("modelos de alimentação instruem a Lívia a consultar o cardápio oficial e as configurações de pedidos", () => {
      for (const t of foodTemplates) {
        expect(t.about.toLowerCase()).toContain("cardápio");
        expect(t.prohibitions.toLowerCase()).toContain("cardápio oficial");
        expect(t.importantInfo.toLowerCase()).toContain("sistema de pedidos");
      }
    });
  });
});
