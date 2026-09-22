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
    }
    expect(KNOWLEDGE_TEMPLATES.length).toBe(10);
  });

  it("todos os modelos possuem todos os campos obrigatórios preenchidos com conteúdo significativo", () => {
    for (const t of KNOWLEDGE_TEMPLATES) {
      expect(t.id.trim()).not.toBe("");
      expect(t.label.trim()).not.toBe("");
      expect(t.matchesTypes.length).toBeGreaterThan(0);
      expect(t.about.trim().length).toBeGreaterThan(20);
      expect(t.services.length).toBeGreaterThan(0);
      for (const s of t.services) {
        expect(s.name.trim()).not.toBe("");
        expect(s.priceText).toBeTruthy();
      }
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

    it("preenche todos os campos quando o formulário está completamente vazio", () => {
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
        services: [{ name: "Pizza de Picanha", priceText: "R$ 80", durationText: null, description: "Exclusiva" }],
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
        services: [], // vazio -> deve preencher
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
      expect(result.paymentMethods).toBe("Pix e Cartão");
      expect(result.toneGuidelines).toBe("Tom amigável");

      // Campos vazios recebem o conteúdo do modelo
      expect(result.services).toEqual(templateBurger.services);
      expect(result.importantInfo).toBe(templateBurger.importantInfo);
      expect(result.prohibitions).toBe(templateBurger.prohibitions);
      expect(result.handoffTriggers).toBe(templateBurger.handoffTriggers);
    });
  });

  describe("Qualidade das diretrizes de alimentação — não concorre com o cardápio oficial", () => {
    it("modelos de alimentação reforçam que cardápio oficial e pedidos são a fonte da verdade", () => {
      const foodTemplates = KNOWLEDGE_TEMPLATES.filter((t) =>
        ["restaurante", "lanchonete", "pizzaria", "hamburgueria"].includes(t.id)
      );

      for (const t of foodTemplates) {
        // Proibições devem impedir inventar pratos/preços fora do cardápio oficial
        expect(t.prohibitions.toLowerCase()).toContain("cardápio");
        // Handoff triggers devem tratar problemas típicos de delivery/pedidos
        expect(t.handoffTriggers.toLowerCase()).toMatch(/pedido|cancelamento|trocado|atrasado/);
        // Important info menciona tempo de entrega/retirada
        expect(t.importantInfo.toLowerCase()).toMatch(/entrega|retirada/);
      }
    });
  });
});
