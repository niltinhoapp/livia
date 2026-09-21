import { describe, expect, it } from "vitest";
import { nextOrderOpening, normalizeOrderHours, orderHoursAvailability } from "@/lib/orderHours";
import type { OrderSettings, ScheduleConfig } from "@/types";

const days = (patch: Record<string, ScheduleConfig["days"][string]>) => ({ "0": null, "1": null, "2": null, "3": null, "4": null, "5": null, "6": null, ...patch });
const schedule = (patch: Record<string, ScheduleConfig["days"][string]>): ScheduleConfig => ({ establishmentId: "a", timezone: "America/Sao_Paulo", utcOffsetMinutes: -180, slotMinutes: 30, defaultDurationMin: 30, leadHours: 2, days: days(patch), reminderTemplateName: null, reminderTemplateLang: "pt_BR", updatedAt: 0 });
const at = (iso: string) => new Date(iso).getTime();
const defaultOrderSettings = (): OrderSettings => ({ pickupEnabled: true, deliveryEnabled: false, deliveryRules: [], acceptedPaymentMethods: ["cash"], pixInstructions: null, notificationTemplates: {}, orderHours: null });

describe("janela operacional de pedidos", () => {
  it("herda o expediente e respeita pausas sem consultar appointments", () => {
    const config = schedule({ "1": { open: "11:00", close: "23:00", breaks: [{ start: "14:00", end: "18:00" }] } });
    expect(orderHoursAvailability(defaultOrderSettings(), config, at("2026-09-21T16:00:00Z")).open).toBe(true); // 13:00
    expect(orderHoursAvailability(defaultOrderSettings(), config, at("2026-09-21T18:00:00Z")).open).toBe(false); // 15:00
    expect(orderHoursAvailability(defaultOrderSettings(), config, at("2026-09-21T22:00:00Z")).open).toBe(true); // 19:00
  });

  it("janela específica sobrescreve somente o recebimento de pedidos", () => {
    const config = schedule({ "1": { open: "12:00", close: "23:00" } });
    const settings = { ...defaultOrderSettings(), orderHours: normalizeOrderHours({ days: days({ "1": { open: "18:00", close: "01:00" } }) }) };
    expect(orderHoursAvailability(settings, config, at("2026-09-21T17:00:00Z")).open).toBe(false); // 14:00
    expect(orderHoursAvailability(settings, config, at("2026-09-21T22:00:00Z")).open).toBe(true); // 19:00
  });

  it("aceita overnight, inclusive a continuação no dia seguinte fechado, e fecha exatamente no limite", () => {
    const config = schedule({ "6": { open: "18:00", close: "02:00" } });
    const settings = defaultOrderSettings();
    expect(orderHoursAvailability(settings, config, at("2026-09-20T02:00:00Z")).open).toBe(true); // sábado 23:00
    expect(orderHoursAvailability(settings, config, at("2026-09-20T04:00:00Z")).open).toBe(true); // domingo 01:00
    expect(orderHoursAvailability(settings, config, at("2026-09-20T05:00:00Z")).open).toBe(false); // domingo 02:00, fechamento exclusivo
  });

  it("calcula próxima abertura no mesmo dia, dia seguinte e pulando dia fechado", () => {
    const config = schedule({ "1": { open: "18:00", close: "23:00" }, "3": { open: "10:00", close: "15:00" } });
    const settings = defaultOrderSettings();
    expect(nextOrderOpening(settings, config, at("2026-09-21T15:00:00Z"))).toEqual({ date: "2026-09-21", time: "18:00" }); // segunda 12:00
    expect(nextOrderOpening(settings, config, at("2026-09-22T04:00:00Z"))).toEqual({ date: "2026-09-23", time: "10:00" }); // terça fechada
  });

  it("rejeita configuração inválida, mas não rejeita close menor que open", () => {
    expect(() => normalizeOrderHours({ days: { "0": { open: "25:00", close: "01:00" } } })).toThrow(/inválido/i);
    expect(normalizeOrderHours({ days: days({ "1": { open: "18:00", close: "01:00" } }) })?.days["1"]).toMatchObject({ open: "18:00", close: "01:00" });
    expect(() => normalizeOrderHours({ days: days({ "1": { open: "10:00", close: "10:00" } }) })).toThrow(/abertura/i);
  });
});
