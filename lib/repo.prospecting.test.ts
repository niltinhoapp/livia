
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  upsertProspectingSession,
  getProspectingSessionByPhone,
  getProspectingSessionByLeadId,
  transitionProspectingSession,
} from "@/lib/repo";

const EST = "est-123";
const LEAD_1 = "lead-1";
const PHONE_1 = "5511999999999";
const PHONE_2 = "5511888888888";

beforeEach(() => {
  fakeDb.reset();
});

describe("Prospecção Assistida pela Lívia - F1", () => {
  it("1. cria PREPARED corretamente e 2. expiresAt = preparedAt + 48h", async () => {
    const now = 10000;
    const session = await upsertProspectingSession(EST, {
      leadId: LEAD_1,
      phone: PHONE_1,
      businessName: "Test",
      segment: "Test Segment",
      initialManualMessage: "Hello",
      now,
    });

    expect(session.status).toBe("PREPARED");
    expect(session.preparedAt).toBe(now);
    expect(session.expiresAt).toBe(now + 48 * 3600 * 1000);
    expect(session.id).toBe(PHONE_1);
  });

  it("3. busca por normalizedPhone e 4. busca por leadId", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1,
      phone: PHONE_1,
      businessName: "Test",
      segment: "Test Segment",
      initialManualMessage: "Hello",
    });

    const byPhone = await getProspectingSessionByPhone(EST, PHONE_1);
    expect(byPhone?.leadId).toBe(LEAD_1);

    const byLead = await getProspectingSessionByLeadId(EST, LEAD_1);
    expect(byLead?.normalizedPhone).toBe(PHONE_1);
  });

  it("5. criação repetida/idempotente não duplica", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1,
      phone: PHONE_1,
      businessName: "Test",
      segment: "Test Segment",
      initialManualMessage: "Hello",
    });

    // Mesmos dados, mesma mensagem -> não quebra
    const repeat = await upsertProspectingSession(EST, {
      leadId: LEAD_1,
      phone: PHONE_1,
      businessName: "Test",
      segment: "Test Segment",
      initialManualMessage: "Hello",
    });

    expect(repeat.status).toBe("PREPARED");
  });

  it("6. mesmo leadId + outro telefone é rejeitado", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1,
      phone: PHONE_1,
      businessName: "Test",
      segment: "Test Segment",
      initialManualMessage: "Hello",
    });

    await expect(
      upsertProspectingSession(EST, {
        leadId: LEAD_1,
        phone: PHONE_2,
        businessName: "Test",
        segment: "Test Segment",
        initialManualMessage: "Hello",
      })
    ).rejects.toThrow("conflict_lead_id_different_phone");
  });

  it("7. mesmo telefone com sessão ativa (não PREPARED) não é sobrescrito", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1,
      phone: PHONE_1,
      businessName: "Test",
      segment: "Test Segment",
      initialManualMessage: "Hello",
    });

    await transitionProspectingSession(EST, PHONE_1, { action: "confirm_manual_send" });

    // Tentativa de criar com outro leadId para o mesmo telefone ativo deve falhar
    await expect(
      upsertProspectingSession(EST, {
        leadId: "lead-2",
        phone: PHONE_1,
        businessName: "Test",
        segment: "Test Segment",
        initialManualMessage: "Hello",
      })
    ).rejects.toThrow("conflict_active_session");
  });

  it("8. initialManualMessage não muda em retry", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1,
      phone: PHONE_1,
      businessName: "Test",
      segment: "Test Segment",
      initialManualMessage: "Hello",
    });

    await expect(
      upsertProspectingSession(EST, {
        leadId: LEAD_1,
        phone: PHONE_1,
        businessName: "Test",
        segment: "Test Segment",
        initialManualMessage: "Changed",
      })
    ).rejects.toThrow("conflict_active_session");
  });

  it("9. PREPARED → WAITING_REPLY e 11. WAITING_REPLY → LIVIA_ACTIVE", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1,
      phone: PHONE_1,
      businessName: "Test",
      segment: "Test Segment",
      initialManualMessage: "Hello",
    });

    const s1 = await transitionProspectingSession(EST, PHONE_1, { action: "confirm_manual_send" }, 20000);
    expect(s1?.status).toBe("WAITING_REPLY");
    expect(s1?.manualSendConfirmedAt).toBe(20000);

    const s2 = await transitionProspectingSession(EST, PHONE_1, { action: "receive_reply" }, 30000);
    expect(s2?.status).toBe("LIVIA_ACTIVE");
    expect(s2?.firstReplyAt).toBe(30000);
  });

  it("10. PREPARED → LIVIA_ACTIVE deve ser permitida", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1,
      phone: PHONE_1,
      businessName: "Test",
      segment: "Test Segment",
      initialManualMessage: "Hello",
    });

    const s1 = await transitionProspectingSession(EST, PHONE_1, { action: "receive_reply" });
    expect(s1?.status).toBe("LIVIA_ACTIVE");
  });

  it("12. LIVIA_ACTIVE → REVEALED → 13. INTERESTED", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1, phone: PHONE_1, businessName: "Test", segment: "Test", initialManualMessage: "Hello",
    });
    await transitionProspectingSession(EST, PHONE_1, { action: "receive_reply" });
    
    const r = await transitionProspectingSession(EST, PHONE_1, { action: "reveal" });
    expect(r?.status).toBe("REVEALED");

    const i = await transitionProspectingSession(EST, PHONE_1, { action: "set_outcome", status: "INTERESTED" });
    expect(i?.status).toBe("INTERESTED");
    expect(i?.outcome).toBe(null); // outcome field is only for terminal states

    // 14. INTERESTED continua permitindo evolução (não é terminal)
    // Se fosse terminal, a próx chamada lançaria erro
    const h = await transitionProspectingSession(EST, PHONE_1, { action: "set_outcome", status: "HUMAN" });
    expect(h?.status).toBe("HUMAN");
    expect(h?.outcome).toBe("human");
  });

  it("15. terminal não regressa", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1, phone: PHONE_1, businessName: "Test", segment: "Test", initialManualMessage: "Hello",
    });
    await transitionProspectingSession(EST, PHONE_1, { action: "abort" }); // vira CLOSED

    await expect(transitionProspectingSession(EST, PHONE_1, { action: "receive_reply" }))
      .rejects.toThrow("invalid_transition_terminal_state");
  });

  it("16. OPTED_OUT não pode ser recriado/sobrescrito", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1, phone: PHONE_1, businessName: "Test", segment: "Test", initialManualMessage: "Hello",
    });
    await transitionProspectingSession(EST, PHONE_1, { action: "opt_out" });

    // Tentativa com mesmo leadId
    await expect(upsertProspectingSession(EST, {
      leadId: LEAD_1, phone: PHONE_1, businessName: "Test", segment: "Test", initialManualMessage: "Hello",
    })).rejects.toThrow("opted_out");

    // Tentativa com outro leadId mas mesmo telefone
    await expect(upsertProspectingSession(EST, {
      leadId: "lead-2", phone: PHONE_1, businessName: "Test", segment: "Test", initialManualMessage: "Hello",
    })).rejects.toThrow("opted_out");
  });

  it("17. EXPIRED não reativa automaticamente", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1, phone: PHONE_1, businessName: "Test", segment: "Test", initialManualMessage: "Hello",
    });
    await transitionProspectingSession(EST, PHONE_1, { action: "expire" });
    
    // Tentar receive_reply deve falhar pois EXPIRED é terminal
    await expect(transitionProspectingSession(EST, PHONE_1, { action: "receive_reply" }))
      .rejects.toThrow("invalid_transition_terminal_state");
  });

  it("18. transição duplicada é idempotente quando apropriado", async () => {
    await upsertProspectingSession(EST, {
      leadId: LEAD_1, phone: PHONE_1, businessName: "Test", segment: "Test", initialManualMessage: "Hello",
    });
    
    await transitionProspectingSession(EST, PHONE_1, { action: "receive_reply" });
    // Receber reply de novo estando em LIVIA_ACTIVE é ignorado
    const s2 = await transitionProspectingSession(EST, PHONE_1, { action: "receive_reply" });
    expect(s2?.status).toBe("LIVIA_ACTIVE");

    await transitionProspectingSession(EST, PHONE_1, { action: "reveal" });
    // Revelar de novo estando em REVEALED é ignorado
    const s3 = await transitionProspectingSession(EST, PHONE_1, { action: "reveal" });
    expect(s3?.status).toBe("REVEALED");
  });

  it("19. concorrência/invariante de criação", async () => {
    // Tenta criar 5 sessões simultâneas para o mesmo leadId, mas telefones diferentes
    // fakeDb.runTransaction serializa, então a primeira passa e as outras falham na checagem
    const p1 = upsertProspectingSession(EST, { leadId: LEAD_1, phone: "5511999999991", businessName: "A", segment: "A", initialManualMessage: "A" });
    const p2 = upsertProspectingSession(EST, { leadId: LEAD_1, phone: "5511999999992", businessName: "A", segment: "A", initialManualMessage: "A" });
    
    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(r => r.status === "rejected");
    
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe("conflict_lead_id_different_phone");
  });
});

describe("incrementProspectingPreRevealCount", () => {
  it("deve incrementar preRevealReplyCount atomicamente se LIVIA_ACTIVE", async () => {
    await import("./repo").then(m => m.upsertProspectingSession("est2", { phone: "5511999990001", leadId: "lead-x", businessName: "Biz", segment: "Seg", initialManualMessage: "msg" }));
    await import("./repo").then(m => m.transitionProspectingSession("est2", "5511999990001", { action: "confirm_manual_send" }));
    await import("./repo").then(m => m.transitionProspectingSession("est2", "5511999990001", { action: "receive_reply" }));
    await import("./repo").then(m => m.incrementProspectingPreRevealCount("est2", "5511999990001", "job-123"));
    const sess = await import("./repo").then(m => m.getProspectingSessionByPhone("est2", "5511999990001"));
    expect(sess?.preRevealReplyCount).toBe(1);
    await import("./repo").then(m => m.incrementProspectingPreRevealCount("est2", "5511999990001", "job-123"));
    const sess2 = await import("./repo").then(m => m.getProspectingSessionByPhone("est2", "5511999990001"));
    expect(sess2?.preRevealReplyCount).toBe(1); // Limite teto
  });
});