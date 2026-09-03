# Migração — identidade canônica de telefone em `Appointment`

**Status: documentada, NÃO executada.** Nada aqui roda automaticamente. Nenhum
deploy executa esta migração.

## Por que existe

`Conversation` e `CustomerProfile` sempre usaram `normalizePhone(...)` como id
do documento. `Appointment.contactPhone` não: era gravado cru pela ferramenta
da IA (`msg.from`) e exatamente como digitado pelo dono na agenda manual do
painel. Toda leitura (`listCustomerAppointments`, `findNextAppointment`,
cancelar, remarcar, confirmar) consulta com `normalizePhone(...)`.

Efeito em produção: um agendamento real ficava invisível para a Lívia, que
respondia ao cliente que ele não tinha horário marcado.

## O que já foi corrigido em código

1. `createAppointment` (`lib/scheduling.ts`) normaliza na escrita. É o único
   ponto de criação do sistema, então cobre a IA e o painel de uma vez.
2. A leitura tem fallback: quando a query canônica não devolve nada, uma
   varredura limitada por janela de datas (180 dias, teto de 300 documentos,
   mesmo índice de campo único que `listAppointments` já usa) compara por
   telefone normalizado em memória. Documentos legados de qualquer formato
   voltam a ser encontrados **sem migração**.

## Limitação que só a migração resolve

O fallback roda apenas quando a query canônica vem **vazia**. Um cliente com
um agendamento canônico **e** outro legado recebe só o canônico — a query não
veio vazia, então o fallback não dispara.

Fazer o fallback rodar sempre resolveria, mas colocaria uma leitura de até 300
documentos no caminho de toda mensagem, inclusive nas contas onde não existe
nenhum documento legado. Não vale o custo permanente.

## Migração proposta (executar manualmente, com backup)

Não é destrutiva: só reescreve `contactPhone` para a forma canônica.

```ts
// scripts/migrate-appointment-phones.ts  (a criar quando for executar)
// Rodar com credenciais de admin, um estabelecimento por vez, DRY_RUN=1 antes.
import { sub } from "@/lib/firebase/admin";
import { normalizePhone } from "@/lib/whatsapp/client";

const DRY_RUN = process.env.DRY_RUN !== "0";

export async function migrar(establishmentId: string) {
  const snap = await sub(establishmentId, "appointments").get();
  let alterados = 0;
  for (const doc of snap.docs) {
    const atual = doc.data().contactPhone as string;
    const canonico = normalizePhone(atual);
    if (atual === canonico) continue;
    alterados++;
    console.log(`${doc.id}: ${atual} -> ${canonico}`);
    if (!DRY_RUN) {
      // contactPhoneLegado preserva o valor original: a migração não perde dado.
      await doc.ref.update({ contactPhone: canonico, contactPhoneLegado: atual });
    }
  }
  return { total: snap.size, alterados };
}
```

Ordem sugerida:

1. Backup/export da coleção `appointments` do estabelecimento.
2. Rodar com `DRY_RUN=1` e conferir a lista de mudanças.
3. Rodar de verdade, um estabelecimento por vez.
4. Conferir no painel que a agenda continua igual.
5. Repetir para os demais estabelecimentos.

## Depois da migração

Com todos os estabelecimentos migrados, o fallback pode ser desligado:

```
LIVIA_LEGACY_PHONE_SCAN=off
```

A variável é opcional. Sem ela, o fallback fica ligado — que é o padrão seguro
e o comportamento atual em produção.
