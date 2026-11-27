/*
 * Open and close, and the collection handles. A handle is the only writer:
 * every write goes through `prepare`, then docstore, and every rejection
 * through `wrap`.
 */
import { openDocStore, type Collection as DocCollection } from "@opfs-lsm/docstore";
import { openDb, type Db } from "@opfs-lsm/kv";
import { ClosedError, ConflictError, NotFoundError, QueryError, ValidationError, wrap, type AnyDbError } from "./errors.js";
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
  /** Ends every subscription with ClosedError `closed`, then closes the storage. A second call returns the first one's promise. */
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

/** What a query needs of the collection it reads. */
export type Table = {
  readonly name: string;
  readonly docs: DocCollection<JsonDoc, any, unknown>;
  readonly owner: { closed: boolean };
  /** The feed of the collection's subscriptions, while it has any. */
  feed: { end(error: AnyDbError): void } | undefined;
};

const TABLE: unique symbol = Symbol("table");

/** The table behind a collection handle. A handle names its database, so a query needs no other way to find it. */
export function tableOf(collection: unknown): Table {
  const table = typeof collection === "object" && collection !== null ? (collection as { [TABLE]?: Table })[TABLE] : undefined;
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
        if (draft.id !== id) throw new ValidationError("id", `"${this.name}": update changed the id of "${id}"`, this.name, id);
        return prepare(this.rules, draft);
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

/** Open on a kv handle, which this function now owns and closes. */
export async function openOn<C extends Collections>(kv: Db, { version, collections }: Omit<OpenOptions<C>, "name">): Promise<Database<C>> {
  const owner = { closed: false };
  const tables: Table[] = [];
  const handles: Record<string, Handle<JsonDoc, unknown>> = {};
  try {
    const store = await openDocStore(kv, docstoreSchema(version, collections));
    for (const [name, def] of Object.entries(collections)) {
      const docs = store.collection(name) as Table["docs"];
      const table: Table = { name, docs, owner, feed: undefined };
      tables.push(table);
      handles[name] = new Handle(table, writeRules(name, def, docs.indexes.values()));
    }
  } catch (err) {
    await kv.close().catch(() => {});
    throw wrap(err);
  }
  let closing: Promise<void> | undefined;
  const close = async () => {
    owner.closed = true;
    for (const table of tables) table.feed?.end(new ClosedError("closed"));
    await kv.close();
  };
  return { collections: handles as never, close: () => (closing ??= close()) };
}
