/**
 * The catalog: the one stored copy of the schema, under CATALOG_KEY. Every
 * writer in every tab derives entries from it, not from its own code, so a
 * tab on an older app version maintains indexes it never declared.
 *
 * Everything here is pure. store.ts reads and writes the key; this module
 * decides what the bytes mean and what the next catalog is.
 */
import { CorruptDatabaseError } from "@opfs-lsm/kv";
import { isObject } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { indexPrefix, rowPrefix, type CollectionId, type IndexId, type ScanTarget } from "./keys.js";
import type { AnySchema, IndexInfo } from "./schema.js";

/** Bumped when stored bytes change meaning. */
const FORMAT = 1;
const MAX_COLLECTION_ID = 0xffff;
const MAX_INDEX_ID = 0xff;
const MAX_FIELDS = 8;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Ends the first field of `by` when it holds an array. */
const ARRAY_MARK = "[]";
const OPTIONS = ["by", "unique", "text"];

export type StoredCatalog = {
  readonly format: typeof FORMAT;
  /** The app version that last changed the catalog. Only a higher declared version may change definitions. */
  readonly version: number;
  /** Every collection and every `clear` takes the next id. Never reused. */
  readonly nextCollectionId: number;
  readonly collections: { readonly [name: string]: StoredCollection };
  /** Prefixes nothing points at any more, swept in the background, then removed from this list. */
  readonly dropped: readonly DroppedPrefix[];
};

type StoredCollection = {
  readonly id: number;
  /** Index ids keep their number across `clear`, since the collection id changes. Never reused. */
  readonly nextIndexId: number;
  readonly indexes: { readonly [name: string]: StoredIndex };
};

type StoredIndex = { readonly id: number; readonly spec: IndexSpec; readonly state: IndexState };

export type IndexSpec =
  | {
      readonly kind: "sorted";
      readonly on: readonly string[];
      readonly unique: boolean;
      /** The first path holds an array: one entry per distinct element. */
      readonly multi: boolean;
    }
  | {
      readonly kind: "text";
      readonly on: readonly string[];
      readonly text: string;
    };

/**
 * building: written by every writer, read by nobody, filled by backfill.
 * ready: written and read.
 * failed: the backfill met data the index cannot hold. Not written, not
 *   read, its prefix is in `dropped`. The next version bump rebuilds it.
 */
export type IndexState =
  | { readonly kind: "building" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly reason: "unique" | "value"; readonly ids: readonly string[] };

/** `64 CC CC`, a cleared collection; or `64 CC CC II`, a removed, redefined or failed index. */
export type DroppedPrefix = { readonly collection: number } | { readonly collection: number; readonly index: number };

export type DeclaredSchema = {
  readonly version: number;
  readonly collections: ReadonlyMap<string, ReadonlyMap<string, IndexSpec>>;
  /** Collections whose documents and indexes a higher version deletes. */
  readonly drop: ReadonlySet<string>;
};

function badSchema(message: string): never {
  throw new DocStoreError("schema", message);
}

function checkField(field: unknown, where: string): string {
  if (typeof field !== "string" || field.split(".").some((s) => s === "")) {
    badSchema(`${where}: ${JSON.stringify(field)} is not a field such as "a.b"`);
  }
  return field;
}

const isArrayField = (field: unknown): field is string => typeof field === "string" && field.endsWith(ARRAY_MARK);

export function normalizeSchema(decl: AnySchema): DeclaredSchema {
  if (!Number.isInteger(decl.version) || decl.version < 1) badSchema("version must be an integer >= 1");
  if (!isObject(decl.collections)) badSchema("collections must be an object");
  const collections = new Map<string, Map<string, IndexSpec>>();
  for (const [name, indexes] of Object.entries(decl.collections)) {
    if (!NAME.test(name)) badSchema(`collection name ${JSON.stringify(name)} must match ${NAME}`);
    if (!isObject(indexes)) badSchema(`collection "${name}" must map index names to indexes`);
    const specs = new Map<string, IndexSpec>();
    for (const [index, d] of Object.entries(indexes)) {
      const where = `index "${index}" of "${name}"`;
      if (!NAME.test(index)) badSchema(`${where}: the name must match ${NAME}`);
      if (!isObject(d)) badSchema(`${where} must be an object`);
      for (const key of Object.keys(d)) {
        if (!OPTIONS.includes(key)) badSchema(`${where}: unknown option "${key}", expected ${OPTIONS.join(", ")}`);
      }
      const by: unknown[] = Array.isArray(d["by"]) ? d["by"] : [d["by"]];
      if (by.length === 0 || by.length > MAX_FIELDS) badSchema(`${where}: by takes 1 to ${MAX_FIELDS} fields`);
      if (by.slice(1).some(isArrayField)) badSchema(`${where}: only the first field of by can end in ${ARRAY_MARK}`);
      const first = by[0];
      const multi = isArrayField(first);
      const on = by.map((f, i) => checkField(multi && i === 0 ? first.slice(0, -ARRAY_MARK.length) : f, where));
      if (new Set(on).size !== on.length) badSchema(`${where}: by repeats a field`);
      const { unique = false, text } = d;
      if (typeof unique !== "boolean") badSchema(`${where}: unique is a boolean`);
      if (text === undefined) {
        specs.set(index, { kind: "sorted", on, unique, multi });
      } else {
        if (unique) badSchema(`${where}: a text index cannot be unique`);
        if (multi) badSchema(`${where}: a text index cannot start with an array field`);
        specs.set(index, { kind: "text", on, text: checkField(text, where) });
      }
    }
    collections.set(name, specs);
  }
  const drop = new Set<string>();
  if (decl.drop !== undefined && !Array.isArray(decl.drop)) badSchema("drop must be an array of collection names");
  for (const name of decl.drop ?? []) {
    if (typeof name !== "string" || !NAME.test(name)) badSchema(`drop: ${JSON.stringify(name)} must match ${NAME}`);
    if (collections.has(name)) badSchema(`"${name}" is both declared and dropped`);
    drop.add(name);
  }
  return { version: decl.version, collections, drop };
}

export function describeIndexes(specs: ReadonlyMap<string, IndexSpec>): ReadonlyMap<string, IndexInfo> {
  const out = new Map<string, IndexInfo>();
  for (const [name, s] of specs) {
    out.set(
      name,
      s.kind === "text"
        ? { kind: "text", by: s.on, unique: false, text: s.text }
        : s.multi
          ? { kind: "multi", by: [s.on[0] + ARRAY_MARK, ...s.on.slice(1)], unique: s.unique }
          : { kind: "sorted", by: s.on, unique: s.unique },
    );
  }
  return out;
}

function sameSpec(a: IndexSpec, b: IndexSpec): boolean {
  if (a.on.length !== b.on.length || a.on.some((p, i) => p !== b.on[i])) return false;
  switch (a.kind) {
    case "sorted":
      return b.kind === "sorted" && a.unique === b.unique && a.multi === b.multi;
    case "text":
      return b.kind === "text" && a.text === b.text;
  }
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** A catalog of another format is a "schema" error: this library cannot read it. A wrong shape is corruption. */
export function parseCatalog(bytes: Uint8Array): StoredCatalog {
  let c: unknown;
  try {
    c = JSON.parse(fromUtf8.decode(bytes));
  } catch {
    throw new CorruptDatabaseError("the docstore catalog is not JSON");
  }
  if (isObject(c) && c["format"] !== FORMAT) {
    badSchema(`the stored catalog has format ${String(c["format"])}; this library reads format ${FORMAT}`);
  }
  if (!isCatalog(c)) throw new CorruptDatabaseError("the docstore catalog has an unknown shape");
  return c;
}

const isId = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;

function isCatalog(c: unknown): c is StoredCatalog {
  return (
    isObject(c) &&
    Number.isInteger(c["version"]) &&
    Number.isInteger(c["nextCollectionId"]) &&
    isObject(c["collections"]) &&
    Object.values(c["collections"]).every(isCollection) &&
    Array.isArray(c["dropped"]) &&
    c["dropped"].every(
      (p) => isObject(p) && isId(p["collection"], MAX_COLLECTION_ID) && (!("index" in p) || isId(p["index"], MAX_INDEX_ID)),
    )
  );
}

function isCollection(c: unknown): boolean {
  return (
    isObject(c) &&
    isId(c["id"], MAX_COLLECTION_ID) &&
    Number.isInteger(c["nextIndexId"]) &&
    isObject(c["indexes"]) &&
    Object.values(c["indexes"]).every(
      (i) => isObject(i) && isId(i["id"], MAX_INDEX_ID) && isSpec(i["spec"]) && isState(i["state"]),
    )
  );
}

function isSpec(s: unknown): boolean {
  if (!isObject(s) || !Array.isArray(s["on"]) || !s["on"].every((p) => typeof p === "string")) return false;
  if (s["kind"] === "sorted") return typeof s["unique"] === "boolean" && typeof s["multi"] === "boolean";
  return s["kind"] === "text" && typeof s["text"] === "string";
}

function isState(s: unknown): boolean {
  if (!isObject(s)) return false;
  if (s["kind"] === "building" || s["kind"] === "ready") return true;
  return (
    s["kind"] === "failed" &&
    (s["reason"] === "unique" || s["reason"] === "value") &&
    Array.isArray(s["ids"]) &&
    s["ids"].every((id) => typeof id === "string")
  );
}

export function encodeCatalog(catalog: StoredCatalog): Uint8Array {
  return utf8.encode(JSON.stringify(catalog));
}

/**
 * What open does to the catalog: the catalog to write, or undefined to keep
 * the stored one. Runs inside `update([CATALOG_KEY])`, so two handles opening
 * at once see each other's result.
 */
export function reconcile(stored: StoredCatalog | undefined, declared: DeclaredSchema): StoredCatalog | undefined {
  if (!stored) return fresh(declared);
  if (declared.version < stored.version) return undefined;
  if (declared.version > stored.version) return upgrade(stored, declared);
  for (const [name, specs] of declared.collections) {
    const indexes = stored.collections[name]?.indexes;
    const same =
      indexes !== undefined &&
      Object.keys(indexes).length === specs.size &&
      [...specs].every(([index, spec]) => indexes[index] !== undefined && sameSpec(indexes[index].spec, spec));
    if (!same) {
      badSchema(`version ${declared.version} is stored with a different "${name}"; bump the version to change it`);
    }
  }
  for (const name of declared.drop) {
    if (stored.collections[name]) badSchema(`version ${declared.version} is stored with "${name}"; bump the version to drop it`);
  }
  return undefined;
}

function fresh(declared: DeclaredSchema): StoredCatalog {
  const empty: StoredCatalog = { format: FORMAT, version: declared.version, nextCollectionId: 1, collections: {}, dropped: [] };
  return upgrade(empty, declared);
}

function upgrade(stored: StoredCatalog, declared: DeclaredSchema): StoredCatalog {
  let nextCollectionId = stored.nextCollectionId;
  const collections = { ...stored.collections };
  let dropped = [...stored.dropped];
  for (const name of declared.drop) {
    const old = collections[name];
    if (!old) continue;
    delete collections[name];
    // The collection prefix covers its index prefixes.
    dropped = [...dropped.filter((p) => p.collection !== old.id), { collection: old.id }];
  }
  for (const [name, specs] of declared.collections) {
    const old = collections[name];
    const id = old?.id ?? nextCollectionId++;
    if (id > MAX_COLLECTION_ID) badSchema("no collection ids left");
    let nextIndexId = old?.nextIndexId ?? 1;
    const indexes: Record<string, StoredIndex> = {};
    for (const [index, spec] of specs) {
      const was = old?.indexes[index];
      if (was && was.state.kind !== "failed" && sameSpec(was.spec, spec)) {
        indexes[index] = was;
        continue;
      }
      if (nextIndexId > MAX_INDEX_ID) badSchema(`"${name}" has no index ids left`);
      indexes[index] = { id: nextIndexId++, spec, state: old ? { kind: "building" } : { kind: "ready" } };
    }
    for (const [index, was] of Object.entries(old?.indexes ?? {})) {
      if (indexes[index] !== was && was.state.kind !== "failed") dropped.push({ collection: id, index: was.id });
    }
    collections[name] = { id, nextIndexId, indexes };
  }
  return { format: FORMAT, version: declared.version, nextCollectionId, collections, dropped };
}

function withIndex(
  c: StoredCatalog,
  collection: string,
  index: IndexId,
  next: (was: StoredIndex, coll: StoredCollection) => { index: StoredIndex; dropped?: DroppedPrefix } | undefined,
): StoredCatalog | undefined {
  const coll = c.collections[collection];
  if (!coll) return undefined;
  const entry = Object.entries(coll.indexes).find(([, i]) => i.id === index);
  const out = entry && next(entry[1], coll);
  if (!entry || !out) return undefined;
  return {
    ...c,
    collections: { ...c.collections, [collection]: { ...coll, indexes: { ...coll.indexes, [entry[0]]: out.index } } },
    dropped: out.dropped ? [...c.dropped, out.dropped] : c.dropped,
  };
}

export function markReady(c: StoredCatalog, collection: string, index: IndexId): StoredCatalog | undefined {
  return withIndex(c, collection, index, (was) =>
    was.state.kind === "building" ? { index: { ...was, state: { kind: "ready" } } } : undefined,
  );
}

export function markFailed(
  c: StoredCatalog,
  collection: string,
  index: IndexId,
  reason: "unique" | "value",
  ids: readonly string[],
): StoredCatalog | undefined {
  return withIndex(c, collection, index, (was, coll) =>
    was.state.kind === "building"
      ? { index: { ...was, state: { kind: "failed", reason, ids } }, dropped: { collection: coll.id, index: was.id } }
      : undefined,
  );
}

/**
 * A new collection id, every index that is not failed ready (the collection
 * is empty, so there is nothing to build), the old `64 CC CC` to `dropped`.
 * Two clears are two clears.
 */
export function clearCollection(c: StoredCatalog, collection: string): StoredCatalog {
  const coll = c.collections[collection];
  if (!coll) badSchema(`the catalog has no collection "${collection}"`);
  if (c.nextCollectionId > MAX_COLLECTION_ID) badSchema("no collection ids left");
  const indexes: Record<string, StoredIndex> = {};
  for (const [name, i] of Object.entries(coll.indexes)) {
    indexes[name] = i.state.kind === "failed" ? i : { ...i, state: { kind: "ready" } };
  }
  return {
    ...c,
    nextCollectionId: c.nextCollectionId + 1,
    collections: { ...c.collections, [collection]: { ...coll, id: c.nextCollectionId, indexes } },
    dropped: [...c.dropped, { collection: coll.id }],
  };
}

const samePrefix = (a: DroppedPrefix, b: DroppedPrefix) =>
  a.collection === b.collection && ("index" in a ? "index" in b && a.index === b.index : !("index" in b));

export function removeDropped(c: StoredCatalog, prefix: DroppedPrefix): StoredCatalog | undefined {
  const dropped = c.dropped.filter((p) => !samePrefix(p, prefix));
  return dropped.length === c.dropped.length ? undefined : { ...c, dropped };
}

export type Path = readonly string[];

export type CompiledSpec =
  | { readonly kind: "sorted"; readonly on: readonly Path[]; readonly unique: boolean; readonly multi: boolean }
  | { readonly kind: "text"; readonly on: readonly Path[]; readonly text: Path };

export type IndexPlan = {
  readonly name: string;
  readonly id: IndexId;
  readonly state: IndexState;
  readonly spec: CompiledSpec;
  readonly target: Extract<ScanTarget, { readonly rowPrefix: Uint8Array }>;
};

export type Unreadable = { readonly kind: "missing" } | { readonly kind: "spec-changed" } | Exclude<IndexState, { kind: "ready" }>;

export type BoundCollection = {
  readonly name: string;
  readonly id: CollectionId;
  readonly rows: Extract<ScanTarget, { readonly kind: "rows" }>;
  /** Every building or ready index in the catalog, declared by this handle or not. Writes derive entries for exactly these. */
  readonly maintained: readonly IndexPlan[];
  /** By declared index name: the plan if this handle may query it, else why not. */
  readonly readable: ReadonlyMap<string, IndexPlan | Unreadable>;
};

export type Bound = {
  /** A write commits only if the stored catalog bytes still equal these. */
  readonly bytes: Uint8Array;
  readonly catalog: StoredCatalog;
  readonly collections: ReadonlyMap<string, BoundCollection>;
};

export function readableTarget(coll: BoundCollection, index: string): ScanTarget {
  const r = coll.readable.get(index);
  if (r === undefined) throw new DocStoreError("schema", `"${coll.name}" has no index "${index}" in this schema`);
  if (!("kind" in r)) return r.target;
  const where = `index "${index}" of "${coll.name}"`;
  switch (r.kind) {
    case "missing":
      throw new DocStoreError("schema", `the stored catalog has no ${where}`);
    case "spec-changed":
      throw new DocStoreError("schema", `a newer schema redefined ${where}`);
    case "building":
      throw new DocStoreError("schema", `a newer schema is building ${where}`);
    case "failed":
      throw new DocStoreError("index-failed", `${where} cannot hold the stored data (${r.reason})`, r.ids);
  }
}

/** Compile `catalog` for a handle that declared `declared`. An index is readable iff its stored spec equals the declared one and it is ready. */
export function bind(bytes: Uint8Array, catalog: StoredCatalog, declared: DeclaredSchema): Bound {
  const collections = new Map<string, BoundCollection>();
  for (const [name, specs] of declared.collections) {
    const stored = catalog.collections[name];
    if (!stored) continue;
    const id = stored.id as CollectionId;
    const rows = rowPrefix(id);
    const maintained = new Map<string, IndexPlan>();
    for (const [index, i] of Object.entries(stored.indexes)) {
      if (i.state.kind !== "failed") maintained.set(index, compile(id, rows, index, i));
    }
    const readable = new Map<string, IndexPlan | Unreadable>();
    for (const [index, spec] of specs) {
      const i = stored.indexes[index];
      if (!i) readable.set(index, { kind: "missing" });
      else if (!sameSpec(i.spec, spec)) readable.set(index, { kind: "spec-changed" });
      else readable.set(index, i.state.kind === "ready" ? maintained.get(index)! : i.state);
    }
    collections.set(name, { name, id, rows: { kind: "rows", prefix: rows }, maintained: [...maintained.values()], readable });
  }
  return { bytes, catalog, collections };
}

function compile(collection: CollectionId, rows: Uint8Array, name: string, i: StoredIndex): IndexPlan {
  const on = i.spec.on.map((p) => p.split("."));
  const spec: CompiledSpec =
    i.spec.kind === "sorted"
      ? { kind: "sorted", on, unique: i.spec.unique, multi: i.spec.multi }
      : { kind: "text", on, text: i.spec.text.split(".") };
  const kind = spec.kind === "text" ? "text" : spec.unique ? "unique" : "sorted";
  const prefix = indexPrefix(collection, i.id as IndexId);
  return { name, id: i.id as IndexId, state: i.state, spec, target: { kind, prefix, rowPrefix: rows, arity: on.length } };
}
