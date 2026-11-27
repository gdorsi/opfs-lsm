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
import { collectionPrefix, fromUtf8, indexPrefix, rowPrefix, utf8, type CollectionId, type IndexId, type IndexTarget, type ScanTarget } from "./keys.js";
import type { IndexInfo, Schema } from "./schema.js";

/** Bumped when stored bytes change meaning. */
const FORMAT = 4;
const MAX_COLLECTION_ID = 0xffff;
const MAX_INDEX_ID = 0xff;
const MAX_FIELDS = 8;
const MAX_INCLUDE = 16;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The catalog keeps names as object keys, so a declared name `Object.prototype` holds, such as `toString`, is refused. A drop may still name one, which an older version could store. */
const isName = (name: string) => NAME.test(name) && !(name in Object.prototype);
/** Ends the first field of `by` when it holds an array. */
const ARRAY_MARK = "[]";
const OPTIONS = ["by", "unique", "text", "include"];

export type StoredCatalog = {
  readonly format: typeof FORMAT;
  /** The app version that last changed the catalog. Only a higher declared version may change definitions. */
  readonly version: number;
  /** Every new collection takes the next id. Never reused. */
  readonly nextCollectionId: number;
  readonly collections: { readonly [name: string]: StoredCollection };
};

type StoredCollection = {
  readonly id: number;
  /** Every new index of the collection takes the next id. Never reused. */
  readonly nextIndexId: number;
  readonly indexes: { readonly [name: string]: StoredIndex };
};

/** `spec` is the index as `indexes` describes it. */
type StoredIndex = { readonly id: number; readonly spec: IndexInfo; readonly state: IndexState };

/**
 * building: written by every writer, read by nobody, filled by backfill.
 * ready: written and read.
 * failed: the backfill met data the index cannot hold. Not written, not
 *   read, its entries deleted. The next version bump rebuilds it.
 */
export type IndexState =
  | { readonly kind: "building" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly reason: "unique" | "value"; readonly ids: readonly string[] };

/**
 * A catalog to store, and the key prefixes the same batch deletes: `64 CC CC`
 * for a cleared or dropped collection, `64 CC CC II` for a removed, redefined
 * or failed index.
 */
export type Edit = { readonly catalog: StoredCatalog; readonly drop: readonly Uint8Array[] };

export type DeclaredSchema = {
  readonly version: number;
  readonly collections: ReadonlyMap<string, ReadonlyMap<string, IndexInfo>>;
  /** Collections whose documents and indexes a higher version deletes. */
  readonly drop: ReadonlySet<string>;
};

function badSchema(message: string): never {
  throw new DocStoreError("schema", message);
}

function checkField(field: unknown, where: string): string {
  if (typeof field !== "string" || field.split(".").includes("") || field.includes(ARRAY_MARK)) {
    badSchema(`${where}: ${JSON.stringify(field)} is not a field such as "a.b", and only the first field of by can end in ${ARRAY_MARK}`);
  }
  return field;
}

function checkInclude(include: unknown, where: string): readonly string[] {
  if (
    !Array.isArray(include) ||
    include.length === 0 ||
    include.length > MAX_INCLUDE ||
    new Set(include).size !== include.length ||
    // A copy, so a hole is checked as undefined: `some` skips it.
    [...include].some((f) => typeof f !== "string" || f === "" || f.includes(".") || f.includes(ARRAY_MARK))
  ) {
    badSchema(`${where}: include takes 1 to ${MAX_INCLUDE} different top-level fields`);
  }
  return [...include];
}

function checkName(name: string, what: string): void {
  if (!isName(name)) badSchema(`${what}: the name must match ${NAME} and not name an Object.prototype member`);
}

export function normalizeSchema(decl: Schema): DeclaredSchema {
  if (!Number.isInteger(decl.version) || decl.version < 1) badSchema("version must be an integer >= 1");
  // A literal `__proto__` key sets the prototype instead of declaring a collection.
  const proto: unknown = isObject(decl.collections) && Object.getPrototypeOf(decl.collections);
  if (proto !== Object.prototype && proto !== null) badSchema("collections must be a plain object: a __proto__ key is not a collection name");
  const collections = new Map<string, Map<string, IndexInfo>>();
  for (const [name, coll] of Object.entries(decl.collections)) {
    checkName(name, `collection "${name}"`);
    const indexes: unknown = coll?.indexes;
    if (!isObject(indexes)) badSchema(`collection "${name}" was not made by collection()`);
    const specs = new Map<string, IndexInfo>();
    for (const [index, d] of Object.entries(indexes)) {
      const where = `index "${index}" of "${name}"`;
      checkName(index, where);
      if (!isObject(d)) badSchema(`${where} must be an object`);
      for (const key of Object.keys(d)) {
        if (!OPTIONS.includes(key)) badSchema(`${where}: unknown option "${key}", expected ${OPTIONS.join(", ")}`);
      }
      if (d["by"] === undefined) badSchema(`${where}: by is required`);
      const by: unknown[] = Array.isArray(d["by"]) ? [...d["by"]] : [d["by"]];
      if (by.length === 0 || by.length > MAX_FIELDS) badSchema(`${where}: by takes 1 to ${MAX_FIELDS} fields`);
      const first = by[0];
      const multi = typeof first === "string" && first.endsWith(ARRAY_MARK);
      const paths = by.map((f, i) => checkField(multi && i === 0 ? first.slice(0, -ARRAY_MARK.length) : f, where));
      if (new Set(paths).size !== paths.length) badSchema(`${where}: by repeats a field`);
      const { unique = false, text, include } = d;
      if (typeof unique !== "boolean") badSchema(`${where}: unique is a boolean`);
      const fields = paths.map((p, i) => (multi && i === 0 ? p + ARRAY_MARK : p));
      if (text === undefined) {
        // A unique entry's value is its id, so it has no room for fields.
        if (unique && include !== undefined) badSchema(`${where}: a unique index cannot include fields`);
        specs.set(index, { kind: multi ? "multi" : "sorted", by: fields, unique, ...(include === undefined ? {} : { include: checkInclude(include, where) }) });
      } else {
        if (unique || multi || include !== undefined) badSchema(`${where}: a text index cannot be unique, start with an array field or include fields`);
        specs.set(index, { kind: "text", by: fields, unique, text: checkField(text, where) });
      }
    }
    collections.set(name, specs);
  }
  const drop: unknown = decl.drop === undefined ? [] : decl.drop;
  if (!Array.isArray(drop) || [...drop].some((name) => typeof name !== "string" || !NAME.test(name))) badSchema(`drop must be an array of collection names matching ${NAME}`);
  for (const name of drop) if (collections.has(name)) badSchema(`"${name}" is both declared and dropped`);
  return { version: decl.version, collections, drop: new Set(drop) };
}

const sameList = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((p, i) => p === b[i]);

function sameSpec(a: IndexInfo, b: IndexInfo): boolean {
  return a.kind === b.kind && sameList(a.by, b.by) && a.unique === b.unique && a.text === b.text && sameList(a.include, b.include);
}

/** A catalog of another format is a "schema" error: this library cannot read it. A wrong shape is corruption. */
export function parseCatalog(bytes: Uint8Array): StoredCatalog {
  let c: unknown;
  try {
    c = JSON.parse(fromUtf8.decode(bytes.subarray(REV_BYTES)));
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
const isStrings = (v: unknown) => Array.isArray(v) && v.every((p) => typeof p === "string");

function isCatalog(c: unknown): c is StoredCatalog {
  return (
    isObject(c) &&
    Number.isInteger(c["version"]) &&
    Number.isInteger(c["nextCollectionId"]) &&
    isObject(c["collections"]) &&
    Object.values(c["collections"]).every(isCollection)
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
  if (!isObject(s) || !isStrings(s["by"]) || typeof s["unique"] !== "boolean") return false;
  const { kind, text, include } = s;
  const by = s["by"] as readonly string[];
  // `kind` and the `[]` mark say the same thing: only a multi index marks a field, and only its first.
  if (by.length === 0 || by.length > MAX_FIELDS || !by.every((f, i) => f.endsWith(ARRAY_MARK) === (kind === "multi" && i === 0))) return false;
  if (kind === "text") return typeof text === "string" && include === undefined && !s["unique"];
  return (kind === "sorted" || kind === "multi") && text === undefined && (include === undefined || (isStrings(include) && !s["unique"]));
}

function isState(s: unknown): boolean {
  if (!isObject(s)) return false;
  if (s["kind"] === "building" || s["kind"] === "ready") return true;
  return (
    s["kind"] === "failed" &&
    (s["reason"] === "unique" || s["reason"] === "value") &&
    isStrings(s["ids"])
  );
}

/**
 * The stored bytes are a revision, then the JSON. Each encoding draws a new
 * random revision, so two catalogs with the same revision are the same write,
 * and a catalog written after `dangerousDestroy` never matches one a handle
 * still holds.
 */
const REV_BYTES = 8;

export function encodeCatalog(catalog: StoredCatalog): Uint8Array {
  const json = utf8.encode(JSON.stringify(catalog));
  const out = new Uint8Array(REV_BYTES + json.length);
  crypto.getRandomValues(out.subarray(0, REV_BYTES));
  out.set(json, REV_BYTES);
  return out;
}

/** Whether `a` and `b` are the same catalog write. Reads the revisions only. */
export function sameCatalog(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < REV_BYTES; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * What open does to the catalog: the catalog to write, or undefined to keep
 * the stored one. Runs inside `update([CATALOG_KEY])`, so two handles opening
 * at once see each other's result.
 */
export function reconcile(stored: StoredCatalog | undefined, declared: DeclaredSchema): Edit | undefined {
  if (!stored) return upgrade({ format: FORMAT, version: declared.version, nextCollectionId: 1, collections: {} }, declared);
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
    if (Object.hasOwn(stored.collections, name)) badSchema(`version ${declared.version} is stored with "${name}"; bump the version to drop it`);
  }
  return undefined;
}

function upgrade(stored: StoredCatalog, declared: DeclaredSchema): Edit {
  let nextCollectionId = stored.nextCollectionId;
  const collections = { ...stored.collections };
  const drop: Uint8Array[] = [];
  for (const name of declared.drop) {
    if (!Object.hasOwn(collections, name)) continue;
    drop.push(collectionPrefix(collections[name]!.id as CollectionId));
    delete collections[name];
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
      // A failed index lost its entries when it failed.
      if (indexes[index] !== was && was.state.kind !== "failed") drop.push(indexPrefix(id as CollectionId, was.id as IndexId));
    }
    collections[name] = { id, nextIndexId, indexes };
  }
  return { catalog: { format: FORMAT, version: declared.version, nextCollectionId, collections }, drop };
}

/**
 * A building index leaves `building` for `state`. A failed one also drops its
 * entries. Anything else is already settled: undefined. The index is named by
 * ids: a collection id is never reused, while a collection dropped and
 * declared again reuses its name and its index ids.
 */
export function settleIndex(
  c: StoredCatalog,
  collection: CollectionId,
  index: IndexId,
  state: Exclude<IndexState, { kind: "building" }>,
): Edit | undefined {
  const found = Object.entries(c.collections).find(([, coll]) => coll.id === collection);
  const entry = found && Object.entries(found[1].indexes).find(([, i]) => i.id === index);
  if (!entry || entry[1].state.kind !== "building") return undefined;
  const [collName, coll] = found;
  const [name, was] = entry;
  return {
    catalog: { ...c, collections: { ...c.collections, [collName]: { ...coll, indexes: { ...coll.indexes, [name]: { ...was, state } } } } },
    drop: state.kind === "failed" ? [indexPrefix(collection, index)] : [],
  };
}

/**
 * Every document and entry deleted, the collection id kept, every index that
 * is not failed ready: the collection is empty, so there is nothing to build,
 * and a backfill finds its index settled. Two clears are two clears.
 */
export function clearCollection(c: StoredCatalog, collection: string): Edit {
  const coll = c.collections[collection];
  if (!coll) badSchema(`the catalog has no collection "${collection}"`);
  const indexes: Record<string, StoredIndex> = {};
  for (const [name, i] of Object.entries(coll.indexes)) {
    indexes[name] = i.state.kind === "failed" ? i : { ...i, state: { kind: "ready" } };
  }
  return {
    catalog: { ...c, collections: { ...c.collections, [collection]: { ...coll, indexes } } },
    drop: [collectionPrefix(coll.id as CollectionId)],
  };
}

export type Path = readonly string[];

export type IndexPlan = {
  readonly name: string;
  readonly id: IndexId;
  readonly state: IndexState;
  /** The stored definition, and where its entries are. */
  readonly target: IndexTarget;
  /** `by` as paths, without the array mark. */
  readonly paths: readonly Path[];
  /** The field a text index reads its words from. */
  readonly text: Path | undefined;
};

type Unreadable = { readonly kind: "missing" } | { readonly kind: "spec-changed" } | Extract<IndexState, { kind: "failed" }>;

export type BoundCollection = {
  readonly name: string;
  readonly id: CollectionId;
  readonly rows: Extract<ScanTarget, { readonly kind: "rows" }>;
  /** Every building or ready index in the catalog, declared by this handle or not. Writes derive entries for exactly these. */
  readonly maintained: readonly IndexPlan[];
  /** By declared index name: the plan if writes maintain it under the declared spec, ready or building, else why not. */
  readonly readable: ReadonlyMap<string, IndexPlan | Unreadable>;
};

export type Bound = {
  /** A write commits only if the stored catalog is still this write. */
  readonly bytes: Uint8Array;
  readonly catalog: StoredCatalog;
  readonly collections: ReadonlyMap<string, BoundCollection>;
};

export function readableTarget(coll: BoundCollection, index: string): ScanTarget {
  const plan = declaredPlan(coll, index);
  if (plan.state.kind === "building") {
    throw new DocStoreError("schema", `a newer schema is building index "${index}" of "${coll.name}"`);
  }
  return plan.target;
}

/** The plan of declared `index`, ready or building. Throws why writes do not maintain it under the declared spec. */
export function declaredPlan(coll: BoundCollection, index: string): IndexPlan {
  const r = coll.readable.get(index);
  if (r === undefined) throw new DocStoreError("schema", `"${coll.name}" has no index "${index}" in this schema`);
  if (!("kind" in r)) return r;
  const where = `index "${index}" of "${coll.name}"`;
  switch (r.kind) {
    case "missing":
      throw new DocStoreError("schema", `the stored catalog has no ${where}`);
    case "spec-changed":
      throw new DocStoreError("schema", `a newer schema redefined ${where}`);
    case "failed":
      throw new DocStoreError("index-failed", `${where} cannot hold the stored data (${r.reason})`, r.ids);
  }
}

/** Compile `catalog` for a handle that declared `declared`. `readable` holds an index's plan when its stored spec equals the declared one and it is ready or building. `readableTarget` refuses a building one. */
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
      else readable.set(index, i.state.kind === "failed" ? i.state : maintained.get(index)!);
    }
    collections.set(name, { name, id, rows: { kind: "rows", prefix: rows }, maintained: [...maintained.values()], readable });
  }
  return { bytes, catalog, collections };
}

function compile(collection: CollectionId, rows: Uint8Array, name: string, i: StoredIndex): IndexPlan {
  const { spec } = i;
  const paths = spec.by.map((f) => (f.endsWith(ARRAY_MARK) ? f.slice(0, -ARRAY_MARK.length) : f).split("."));
  const target = { ...spec, prefix: indexPrefix(collection, i.id as IndexId), rowPrefix: rows };
  return { name, id: i.id as IndexId, state: i.state, target, paths, text: spec.text?.split(".") };
}
