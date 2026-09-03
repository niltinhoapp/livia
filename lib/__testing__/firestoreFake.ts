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

  reset(): void {
    this.store.clear();
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
        const v = r.data[f.field] as never;
        if (v === undefined) return false;
        if (f.op === "==") return v === f.value;
        if (f.op === ">=") return v >= (f.value as never);
        return v < (f.value as never);
      });
    }

    if (this.order) {
      const { field, dir } = this.order;
      // Firestore exclui documentos que não têm o campo do orderBy.
      rows = rows.filter((r) => r.data[field] !== undefined);
      rows.sort((a, b) => {
        const av = a.data[field] as never;
        const bv = b.data[field] as never;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return dir === "asc" ? cmp : -cmp;
      });
    }

    if (this.after) {
      const field = this.order?.field ?? "startAt";
      const cursor = this.after[field] as never;
      const cursorId = this.after.id;
      const idx = rows.findIndex((r) => r.data[field] === cursor && r.data.id === cursorId);
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

  async set(data: Doc): Promise<void> {
    this.fs.col(this.path).set(this.id, { ...data });
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

  async update(patch: Doc): Promise<void> {
    const cur = this.fs.col(this.path).get(this.id);
    if (!cur) throw new Error(`5 NOT_FOUND: ${this.path}/${this.id}`);
    this.fs.col(this.path).set(this.id, { ...cur, ...patch });
  }

  async delete(): Promise<void> {
    this.fs.col(this.path).delete(this.id);
  }
}

export const fakeDb = new FakeFirestore();

export const establishmentRef = (id: string) => fakeDb.collection("establishments").doc(id);
export const sub = (establishmentId: string, name: string) => establishmentRef(establishmentId).collection(name);
