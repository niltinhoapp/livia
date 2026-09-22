// Fake em memória do subconjunto da API do Firestore que lib/scheduling.ts e
// lib/repo.ts realmente usam. Existe para permitir teste de ORQUESTRAÇÃO:
// escrever por um caminho real (createAppointment, POST /api/appointments) e
// ler pelos caminhos reais (listCustomerAppointments, findNextAppointment)
// sem Firestore de verdade.
//
// Não é usado em produção. Fica fora do glob de testes (**/*.test.ts) de
// propósito: é infraestrutura de teste, não um teste.

type Doc = Record<string, unknown>;

interface Filter {
  field: string;
  op: "==" | ">=" | "<";
  value: unknown;
}

export class FakeFirestore {
  // caminho da coleção -> (docId -> dados)
  private store = new Map<string, Map<string, Doc>>();
  private transactionTail: Promise<void> = Promise.resolve();
  private forcedTransactionRetries = 0;
  private activeTransactions = 0;

  reset(): void {
    this.store.clear();
    this.transactionTail = Promise.resolve();
    this.forcedTransactionRetries = 0;
    this.activeTransactions = 0;
  }

  col(path: string): Map<string, Doc> {
    let c = this.store.get(path);
    if (!c) {
      c = new Map();
      this.store.set(path, c);
    }
    return c;
  }

  // Quantas leituras de documento a suíte provocou — usado para provar que a
  // correção do limit/paginação continua com custo limitado.
  reads = 0;

  collection(path: string): FakeCollection {
    return new FakeCollection(this, path);
  }

  retryNextTransaction(times = 1): void {
    this.forcedTransactionRetries = times;
  }

  isTransactionActive(): boolean {
    return this.activeTransactions > 0;
  }

  async runTransaction<T>(callback: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const retries = this.forcedTransactionRetries;
      this.forcedTransactionRetries = 0;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const tx = new FakeTransaction();
        this.activeTransactions += 1;
        let result: T;
        try {
          result = await callback(tx);
        } finally {
          this.activeTransactions -= 1;
        }
        // Simula retry/rollback do Firestore: efeitos enfileirados na primeira
        // callback são descartados; só a última tentativa é commitada.
        if (attempt < retries) continue;
        await tx.commit();
        return result;
      }
      throw new Error("FakeFirestore: transaction retry loop inválido");
    } finally {
      release();
    }
  }
}

function fieldValue(data: Doc, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Doc)[part];
  }, data);
}

function applyPatch(target: Doc, patch: Doc): Doc {
  const next = { ...target };
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".");
    let cursor = next;
    for (const part of parts.slice(0, -1)) {
      const existing = cursor[part];
      cursor[part] = existing && typeof existing === "object" ? { ...(existing as Doc) } : {};
      cursor = cursor[part] as Doc;
    }
    cursor[parts.at(-1)!] = value;
  }
  return next;
}

class FakeQuery {
  constructor(
    protected fs: FakeFirestore,
    protected path: string,
    protected filters: Filter[] = [],
    protected order: { field: string; dir: "asc" | "desc" } | null = null,
    protected limitCount: number | null = null,
    protected after: Doc | null = null,
  ) {}

  private clone(patch: Partial<{ filters: Filter[]; order: FakeQuery["order"]; limitCount: number | null; after: Doc | null }>): FakeQuery {
    return new FakeQuery(
      this.fs,
      this.path,
      patch.filters ?? this.filters,
      patch.order !== undefined ? patch.order : this.order,
      patch.limitCount !== undefined ? patch.limitCount : this.limitCount,
      patch.after !== undefined ? patch.after : this.after,
    );
  }

  where(field: string, op: Filter["op"], value: unknown): FakeQuery {
    return this.clone({ filters: [...this.filters, { field, op, value }] });
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return this.clone({ order: { field, dir } });
  }

  limit(n: number): FakeQuery {
    return this.clone({ limitCount: n });
  }

  startAfter(doc: { data(): Doc }): FakeQuery {
    return this.clone({ after: doc.data() });
  }

  async get(): Promise<{ docs: { id: string; data(): Doc }[]; size: number; empty: boolean }> {
    let rows = [...this.fs.col(this.path).entries()].map(([id, data]) => ({ id, data }));

    for (const f of this.filters) {
      rows = rows.filter((r) => {
        const v = fieldValue(r.data, f.field) as never;
        if (v === undefined) return false;
        if (f.op === "==") return v === f.value;
        if (f.op === ">=") return v >= (f.value as never);
        return v < (f.value as never);
      });
    }

    if (this.order) {
      const { field, dir } = this.order;
      // Firestore exclui documentos que não têm o campo do orderBy.
      rows = rows.filter((r) => fieldValue(r.data, field) !== undefined);
      rows.sort((a, b) => {
        const av = fieldValue(a.data, field) as never;
        const bv = fieldValue(b.data, field) as never;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return dir === "asc" ? cmp : -cmp;
      });
    }

    if (this.after) {
      const field = this.order?.field ?? "startAt";
      const cursor = fieldValue(this.after, field) as never;
      const cursorId = this.after.id;
      const idx = rows.findIndex((r) => fieldValue(r.data, field) === cursor && r.data.id === cursorId);
      rows = idx >= 0 ? rows.slice(idx + 1) : rows;
    }

    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);

    this.fs.reads += rows.length;

    return {
      docs: rows.map((r) => ({ id: r.id, data: () => r.data })),
      size: rows.length,
      empty: rows.length === 0,
    };
  }
}

class FakeCollection extends FakeQuery {
  private autoId = 0;

  doc(id?: string): FakeDoc {
    const docId = id ?? `auto_${this.path}_${++this.autoId}_${Math.random().toString(36).slice(2, 8)}`;
    return new FakeDoc(this.fs, this.path, docId);
  }
}

class FakeDoc {
  constructor(
    private fs: FakeFirestore,
    private path: string,
    public id: string,
  ) {}

  collection(name: string): FakeCollection {
    return new FakeCollection(this.fs, `${this.path}/${this.id}/${name}`);
  }

  async get(): Promise<{ exists: boolean; data(): Doc | undefined }> {
    const data = this.fs.col(this.path).get(this.id);
    if (data) this.fs.reads++;
    return { exists: data !== undefined, data: () => data };
  }

  async set(data: Doc, options?: { merge?: boolean }): Promise<void> {
    const current = this.fs.col(this.path).get(this.id);
    this.fs.col(this.path).set(this.id, options?.merge && current ? applyPatch(current, data) : { ...data });
  }

  // Semântica do Firestore: falha se o documento já existir. É isto que dá a
  // atomicidade do dedupe de mensagens (lib/repo.ts: alreadyProcessed).
  async create(data: Doc): Promise<void> {
    if (this.fs.col(this.path).has(this.id)) {
      const err = new Error(`6 ALREADY_EXISTS: Document already exists: ${this.path}/${this.id}`) as Error & {
        code: number;
      };
      err.code = 6;
      throw err;
    }
    this.fs.col(this.path).set(this.id, { ...data });
  }

  // Semântica do Firestore real: um update precisa alterar pelo menos um
  // campo. O SDK valida isso antes de enviar qualquer coisa
  // (@google-cloud/firestore, write-batch.js: validateUpdateMap) e lança
  // "At least one field must be updated.". Sem esta checagem o fake aceitava
  // update({}) em silêncio, e um caminho de no-op que chamava update com um
  // patch vazio passava nos testes e só quebrava em runtime real (OT-05H-B).
  async update(patch: Doc): Promise<void> {
    const cur = this.fs.col(this.path).get(this.id);
    if (!cur) throw new Error(`5 NOT_FOUND: ${this.path}/${this.id}`);
    if (Object.keys(patch).length === 0) throw new Error("At least one field must be updated.");
    this.fs.col(this.path).set(this.id, applyPatch(cur, patch));
  }

  async delete(): Promise<void> {
    this.fs.col(this.path).delete(this.id);
  }
}

class FakeTransaction {
  private operations: Array<() => Promise<void>> = [];

  async get<T extends { get(): Promise<unknown> }>(target: T): Promise<Awaited<ReturnType<T["get"]>>> {
    return target.get() as Promise<Awaited<ReturnType<T["get"]>>>;
  }

  set(ref: FakeDoc, data: Doc, options?: { merge?: boolean }): void {
    this.operations.push(() => ref.set(data, options));
  }

  update(ref: FakeDoc, patch: Doc): void {
    this.operations.push(() => ref.update(patch));
  }

  create(ref: FakeDoc, data: Doc): void {
    this.operations.push(() => ref.create(data));
  }

  delete(ref: FakeDoc): void {
    this.operations.push(() => ref.delete());
  }

  async commit(): Promise<void> {
    for (const operation of this.operations) await operation();
  }
}

export const fakeDb = new FakeFirestore();

export const establishmentRef = (id: string) => fakeDb.collection("establishments").doc(id);
export const sub = (establishmentId: string, name: string) => establishmentRef(establishmentId).collection(name);
