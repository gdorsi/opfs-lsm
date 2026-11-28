/*
 * Open and close, and the collection handles. A handle is the only writer:
 * every write goes through `prepare`, then docstore, and every rejection
 * through `wrap`.
 */
import { openDocStore, type Collection as DocCollection } from "@opfs-lsm/docstore";
import { destroyDb, openDb, type Db } from "@opfs-lsm/kv";
import { ClosedError, ConflictError, NotFoundError, QueryError, ValidationError, wrap } from "./errors.js";
import { docstoreSchema, isId, prepare, writeRules, type Collections, type DocOf, type InputOf, type JsonDoc, type WriteRules } from "./schema.js";

export type OpenOptions<C extends Collections> = {
  /** One name is one database, shared by every tab of the origin. */
  readonly name: string;
  /** An integer of at least 1. Raise it whenever `collections` or their indexes change. */
  readonly version: number;
  readonly collections: C;
};

export interface Database<C extends Collections> {
  readonly collections: { readonly [K in keyof C & string]: Collection<DocOf<C[K]>, InputOf<C[K]>> };
  /** Closes the storage, which ends every subscription with ClosedError `closed`. A second call returns the first one's promise. */
  close(): Promise<void>;
}

/** A document an `update` callback may change in place. */
export type Draft<T> = { -readonly [K in keyof T]: T[K] };

/** One collection of an open database. `T` is the stored document, `In` what a write takes. */
export interface Collection<T extends JsonDoc, In = T> {
  readonly name: string;
  get(id: string): Promise<T | undefined>;
  /** Store new documents in one transaction. ConflictError `duplicate` if an id exists, and then nothing is stored. */
  insert(docs: In | readonly In[]): Promise<void>;
  /** Store documents in one transaction, replacing those that exist. */
  upsert(docs: In | readonly In[]): Promise<void>;
  /**
   * Read, change, validate and write one document in one transaction. `fn`
   * changes the draft in place and may run more than once, so it must be
   * pure. Resolves with the stored document. NotFoundError if there is none.
   */
  update(id: string, fn: (draft: Draft<T>) => void): Promise<T>;
  /** A missing id is not an error. */
  delete(ids: string | readonly string[]): Promise<void>;
}

/** What a query needs of the collection it reads. @internal */
export type Table = {
  readonly name: string;
  readonly docs: DocCollection<JsonDoc, any, unknown>;
  readonly owner: { closed: boolean };
};

const TABLE: unique symbol = Symbol("table");

/** The table behind a collection handle. A handle names its database, so a query needs no other way to find it. @internal */
export function tableOf(collection: unknown): Table {
  const table = (collection as { [TABLE]?: Table } | null | undefined)?.[TABLE];
  if (!table) throw new QueryError("source", "from takes a collection of an open database");
  return table;
}

const list = <V>(v: V | readonly V[]): readonly V[] => (Array.isArray(v) ? v : [v as V]);

class Handle<T extends JsonDoc, In> implements Collection<T, In> {
  readonly [TABLE]: Table;

  constructor(
    table: Table,
    private readonly rules: WriteRules,
  ) {
    this[TABLE] = table;
  }

  get name(): string {
    return this.rules.name;
  }

  private async run<R>(body: (docs: Table["docs"]) => Promise<R>): Promise<R> {
    const { owner, docs } = this[TABLE];
    try {
      if (owner.closed) throw new ClosedError("closed");
      return await body(docs);
    } catch (err) {
      throw wrap(err, this.name);
    }
  }

  private prepared(input: In | readonly In[]): JsonDoc[] {
    const docs = list(input).map((doc) => prepare(this.rules, doc));
    if (new Set(docs.map((d) => d.id)).size !== docs.length) throw new ValidationError("id", `"${this.name}": one call got an id twice`, this.name);
    return docs;
  }

  get(id: string): Promise<T | undefined> {
    return this.run(async (docs) => (isId(id) ? ((await docs.get(id)) as T | undefined) : undefined));
  }

  insert(input: In | readonly In[]): Promise<void> {
    return this.run((docs) => {
      const next = this.prepared(input);
      return docs.modifyMany(
        next.map((d) => d.id),
        (stored) => {
          const at = stored.findIndex((s) => s !== undefined);
          if (at >= 0) throw new ConflictError("duplicate", `"${this.name}" already has a document "${next[at]!.id}"`, this.name, [next[at]!.id]);
          return next;
        },
      );
    });
  }

  upsert(input: In | readonly In[]): Promise<void> {
    return this.run((docs) => docs.putMany(this.prepared(input)));
  }

  update(id: string, fn: (draft: Draft<T>) => void): Promise<T> {
    return this.run(async (docs) => {
      // docstore hands `fn` a fresh copy of the row on each run, so the draft can be changed in place.
      const change = (draft: JsonDoc) => {
        fn(draft as Draft<T>);
        const next = prepare(this.rules, draft);
        // The validator may rewrite the id too.
        if (next.id !== id) throw new ValidationError("id", `"${this.name}": update changed the id of "${id}"`, this.name, id);
        return next;
      };
      const stored = isId(id) ? await docs.modify(id, change) : undefined;
      if (!stored) throw new NotFoundError(this.name, id);
      return stored as T;
    });
  }

  delete(ids: string | readonly string[]): Promise<void> {
    return this.run(async (docs) => {
      await docs.deleteMany(list(ids).filter(isId));
    });
  }
}

export async function openDatabase<C extends Collections>(options: OpenOptions<C>): Promise<Database<C>> {
  let kv: Db;
  try {
    kv = await openDb({ name: options.name });
  } catch (err) {
    throw wrap(err);
  }
  return openOn(kv, options);
}

/**
 * Delete the database `name`, in every tab of the origin. Each open handle
 * on it ends its subscriptions with ClosedError `destroyed`, and its later
 * calls reject with ClosedError. Resolves once the storage is gone.
 */
export async function deleteDatabase(name: string): Promise<void> {
  try {
    await destroyDb(name);
  } catch (err) {
    throw wrap(err);
  }
}

/** Open on a kv handle, which this function now owns and closes. @internal */
export async function openOn<C extends Collections>(kv: Db, { version, collections }: Omit<OpenOptions<C>, "name">): Promise<Database<C>> {
  const owner = { closed: false };
  const handles: Record<string, Handle<JsonDoc, unknown>> = {};
  try {
    const store = await openDocStore(kv, docstoreSchema(version, collections));
    for (const [name, def] of Object.entries(collections)) {
      const docs = store.collection(name) as Table["docs"];
      handles[name] = new Handle({ name, docs, owner }, writeRules(name, def, docs.indexes.values()));
    }
  } catch (err) {
    await kv.close().catch(() => {});
    throw wrap(err);
  }
  let closing: Promise<void> | undefined;
  const close = async () => {
    owner.closed = true;
    try {
      await kv.close();
    } catch (err) {
      throw wrap(err);
    }
  };
  return { collections: handles as never, close: () => (closing ??= close()) };
}
