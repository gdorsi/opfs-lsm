import { openDb, type Db, type OpenOptions } from "@opfs-lsm/kv";
import { Table, type TableSchema } from "./table.js";

export type CollectionSchema = {
  readonly tables: readonly TableSchema[];
};

export type OpenCollectionOptions = OpenOptions & {
  readonly schema: CollectionSchema;
};

export class CollectionDb {
  private readonly tables = new Map<string, Table>();

  constructor(
    readonly kv: Db,
    schema: CollectionSchema,
  ) {
    for (const t of schema.tables) {
      if (this.tables.has(t.name)) {
        throw new Error(`duplicate table: ${t.name}`);
      }
      this.tables.set(t.name, new Table(kv, t));
    }
  }

  table<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
  ): Table<T> {
    const t = this.tables.get(name);
    if (!t) throw new Error(`unknown table: ${name}`);
    return t as Table<T>;
  }

  ingest(): Promise<{ generation: number }> {
    return this.kv.ingest();
  }

  close(): Promise<void> {
    return this.kv.close();
  }
}

export async function openCollectionDb(
  options: OpenCollectionOptions,
): Promise<CollectionDb> {
  const { schema, ...open } = options;
  const kv = await openDb(open);
  return new CollectionDb(kv, schema);
}
