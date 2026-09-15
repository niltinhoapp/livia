import { describe, expect, it } from "vitest";
import { declaresAutomatedRecipient, isClearClosingReply, isClearHumanDemand, isPureSocialFarewell } from "./conversationClosure";

const general = { type: "general_question", confidence: 0.3, entities: {} } as const;
const schedule = { type: "schedule_appointment", confidence: 0.8, entities: {} } as const;

describe("conversationClosure", () => {
  it.each([
    "Sou uma assistente virtual", "Sou o assistente virtual da empresa", "Eu sou uma assistente virtual",
    "Este é um atendimento automatizado", "Você está falando com nossa assistente virtual",
    "Olá, sou a assistente virtual do STUDIO E NAILS",
  ])("reconhece apenas autodeclaração automatizada: %s", (text) => {
    expect(declaresAutomatedRecipient(text)).toBe(true);
  });

  it.each([
    "vocês usam assistente virtual?", "quero uma assistente virtual", "o bot de vocês funciona como?",
    "estou procurando atendimento automatizado", "não quero falar com bot", "não quero uma resposta automática",
    "recebi uma mensagem automática", "vocês têm atendimento automatizado?", "preciso configurar um bot",
  ])("não fecha conversa humana: %s", (text) => {
    expect(declaresAutomatedRecipient(text)).toBe(false);
  });

  it.each([
    "até mais", "tchau", "obrigado", "obrigada", "valeu", "bom dia pra vocês também",
    "não preciso de nada obrigado", "não preciso de nada, obrigada", "obrigado pelo atendimento",
    "tenha um ótimo dia", "ótimo dia pra vocês", "qualquer coisa eu chamo",
  ])("reconhece despedida social completa: %s", (text) => {
    expect(isPureSocialFarewell(text)).toBe(true);
  });

  it.each([
    "obrigado, quero marcar amanhã", "até mais, mas antes quanto custa?", "valeu, pode cancelar meu horário",
    "tchau, preciso remarcar", "obrigada, vocês atendem sábado?", "não preciso disso, preciso de outro serviço",
  ])("preserva uma demanda real: %s", (text) => {
    expect(isPureSocialFarewell(text)).toBe(false);
  });

  it("reabre automated_recipient só para demanda humana inequívoca", () => {
    expect(isClearHumanDemand("quero marcar um horário amanhã", schedule)).toBe(true);
    expect(isClearHumanDemand("quanto custa o serviço?", general)).toBe(true);
    expect(isClearHumanDemand("preciso falar com alguém", general)).toBe(true);
    expect(isClearHumanDemand("vocês atendem sábado?", general)).toBe(true);
    expect(isClearHumanDemand("oi", general)).toBe(false);
    expect(isClearHumanDemand("qualquer coisa é só chamar", general)).toBe(false);
  });

  it("só aceita uma resposta anterior conclusiva", () => {
    expect(isClearClosingReply("Tudo certo. Quando quiser, é só chamar!")).toBe(true);
    expect(isClearClosingReply("Posso ajudar em algo mais?")).toBe(false);
  });
});
