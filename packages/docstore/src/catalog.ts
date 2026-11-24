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
import { fromUtf8, indexPrefix, rowPrefix, utf8, type CollectionId, type IndexId, type ScanTarget } from "./keys.js";
import type { IndexInfo, Schema } from "./schema.js";

/**
 * Bumped when stored bytes change meaning. A catalog has the lowest format
 * that describes it: `FORMAT_COUNT` while it holds a count index, which a
 * library that reads only `FORMAT` would not keep in step with the
 * documents. Not 3: databases hold a format 3 that this library does not
 * read.
 */
const FORMAT = 2;
const FORMAT_COUNT = 4;
const MAX_COLLECTION_ID = 0xffff;
const MAX_INDEX_ID = 0xff;
const MAX_FIELDS = 8;
const MAX_INCLUDE = 16;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The catalog keeps names as object keys, so a declared name `Object.prototype` holds, such as `toString`, is refused. A drop may still name one, which an older version could store. */
const isName = (name: string) => NAME.test(name) && !(name in Object.prototype);
/** Ends the first field of `by` when it holds an array. */
const ARRAY_MARK = "[]";
const OPTIONS = ["by", "unique", "text", "include", "count"];

export type StoredCatalog = {
  readonly format: typeof FORMAT | typeof FORMAT_COUNT;
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
      /** Top-level fields each entry's value holds. Absent: the value is empty. */
      readonly include?: readonly string[];
    }
  | {
      readonly kind: "text";
      readonly on: readonly string[];
      readonly text: string;
    }
  | {
      /** How many documents hold each value tuple of `on`. It has no entries. */
      readonly kind: "count";
      readonly on: readonly string[];
      /** The first path holds an array: a document counts once per distinct element. */
      readonly multi: boolean;
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
    include.some((f) => typeof f !== "string" || f === "" || f.includes(".") || f.includes(ARRAY_MARK))
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
  const collections = new Map<string, Map<string, IndexSpec>>();
  for (const [name, coll] of Object.entries(decl.collections)) {
    checkName(name, `collection "${name}"`);
    const indexes: unknown = coll?.indexes;
    if (!isObject(indexes)) badSchema(`collection "${name}" was not made by collection()`);
    const specs = new Map<string, IndexSpec>();
    for (const [index, d] of Object.entries(indexes)) {
      const where = `index "${index}" of "${name}"`;
      checkName(index, where);
      if (!isObject(d)) badSchema(`${where} must be an object`);
      for (const key of Object.keys(d)) {
        if (!OPTIONS.includes(key)) badSchema(`${where}: unknown option "${key}", expected ${OPTIONS.join(", ")}`);
      }
      if (d["by"] === undefined) badSchema(`${where}: by is required`);
      const by: unknown[] = Array.isArray(d["by"]) ? d["by"] : [d["by"]];
      if (by.length === 0 || by.length > MAX_FIELDS) badSchema(`${where}: by takes 1 to ${MAX_FIELDS} fields`);
      const first = by[0];
      const multi = typeof first === "string" && first.endsWith(ARRAY_MARK);
      const on = by.map((f, i) => checkField(multi && i === 0 ? first.slice(0, -ARRAY_MARK.length) : f, where));
      if (new Set(on).size !== on.length) badSchema(`${where}: by repeats a field`);
      const { unique = false, text, include, count } = d;
      if (count !== undefined) {
        if (count !== true || Object.keys(d).length > 2) badSchema(`${where}: a count index takes only by`);
        specs.set(index, { kind: "count", on, multi });
        continue;
      }
      if (typeof unique !== "boolean") badSchema(`${where}: unique is a boolean`);
      if (text === undefined) {
        // A unique entry's value is its id, so it has no room for fields.
        if (unique && include !== undefined) badSchema(`${where}: a unique index cannot include fields`);
        specs.set(index, { kind: "sorted", on, unique, multi, ...(include === undefined ? {} : { include: checkInclude(include, where) }) });
      } else {
        if (unique || multi || include !== undefined) badSchema(`${where}: a text index cannot be unique, start with an array field or include fields`);
        specs.set(index, { kind: "text", on, text: checkField(text, where) });
      }
    }
    collections.set(name, specs);
  }
  const drop: unknown = decl.drop === undefined ? [] : decl.drop;
  if (!Array.isArray(drop) || drop.some((name) => typeof name !== "string" || !NAME.test(name))) badSchema(`drop must be an array of collection names matching ${NAME}`);
  for (const name of drop) if (collections.has(name)) badSchema(`"${name}" is both declared and dropped`);
  return { version: decl.version, collections, drop: new Set(drop) };
}

/** The indexes `query` reads. A count index is left out: it has no entries. */
export function describeIndexes(specs: ReadonlyMap<string, IndexSpec>): ReadonlyMap<string, IndexInfo> {
  const out = new Map<string, IndexInfo>();
  for (const [name, s] of specs) {
    if (s.kind === "count") continue;
    out.set(
      name,
      s.kind === "text"
        ? { kind: "text", by: s.on, unique: false, text: s.text }
        : {
            kind: s.multi ? "multi" : "sorted",
            by: s.multi ? [s.on[0] + ARRAY_MARK, ...s.on.slice(1)] : s.on,
            unique: s.unique,
            ...(s.include && { include: s.include }),
          },
    );
  }
  return out;
}

const sameList = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((p, i) => p === b[i]);

function sameSpec(a: IndexSpec, b: IndexSpec): boolean {
  if (!sameList(a.on, b.on)) return false;
  switch (a.kind) {
    case "sorted":
      return b.kind === "sorted" && a.unique === b.unique && a.multi === b.multi && sameList(a.include, b.include);
    case "text":
      return b.kind === "text" && a.text === b.text;
    case "count":
      return b.kind === "count" && a.multi === b.multi;
  }
}

/** A catalog of another format is a "schema" error: this library cannot read it. A wrong shape is corruption. */
export function parseCatalog(bytes: Uint8Array): StoredCatalog {
  let c: unknown;
  try {
    c = JSON.parse(fromUtf8.decode(bytes.subarray(REV_BYTES)));
  } catch {
    throw new CorruptDatabaseError("the docstore catalog is not JSON");
  }
  if (isObject(c) && c["format"] !== FORMAT && c["format"] !== FORMAT_COUNT) {
    badSchema(`the stored catalog has format ${String(c["format"])}; this library reads formats ${FORMAT} and ${FORMAT_COUNT}`);
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
  if (!isObject(s) || !isStrings(s["on"])) return false;
  if (s["kind"] === "sorted") {
    const include = s["include"];
    return typeof s["unique"] === "boolean" && typeof s["multi"] === "boolean" && (include === undefined || (isStrings(include) && !s["unique"]));
  }
  if (s["kind"] === "count") return typeof s["multi"] === "boolean";
  return s["kind"] === "text" && typeof s["text"] === "string";
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
export function reconcile(stored: StoredCatalog | undefined, declared: DeclaredSchema): StoredCatalog | undefined {
  if (!stored) {
    return upgrade({ format: FORMAT, version: declared.version, nextCollectionId: 1, collections: {}, dropped: [] }, declared);
  }
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

function upgrade(stored: StoredCatalog, declared: DeclaredSchema): StoredCatalog {
  let nextCollectionId = stored.nextCollectionId;
  const collections = { ...stored.collections };
  let dropped = [...stored.dropped];
  for (const name of declared.drop) {
    if (!Object.hasOwn(collections, name)) continue;
    const old = collections[name]!;
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
  // Only this function changes which indexes a catalog holds, so only it chooses the format.
  const counted = Object.values(collections).some((coll) => Object.values(coll.indexes).some((i) => i.spec.kind === "count"));
  return { format: counted ? FORMAT_COUNT : FORMAT, version: declared.version, nextCollectionId, collections, dropped };
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
): StoredCatalog | undefined {
  const found = Object.entries(c.collections).find(([, coll]) => coll.id === collection);
  const entry = found && Object.entries(found[1].indexes).find(([, i]) => i.id === index);
  if (!entry || entry[1].state.kind !== "building") return undefined;
  const [collName, coll] = found;
  const [name, was] = entry;
  return {
    ...c,
    collections: { ...c.collections, [collName]: { ...coll, indexes: { ...coll.indexes, [name]: { ...was, state } } } },
    dropped: state.kind === "failed" ? [...c.dropped, { collection, index }] : c.dropped,
  };
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
  | {
      readonly kind: "sorted";
      readonly on: readonly Path[];
      readonly unique: boolean;
      readonly multi: boolean;
      readonly include: readonly string[] | undefined;
    }
  | { readonly kind: "text"; readonly on: readonly Path[]; readonly text: Path }
  | { readonly kind: "count"; readonly on: readonly Path[]; readonly multi: boolean };

export type IndexPlan = {
  readonly name: string;
  readonly id: IndexId;
  readonly state: IndexState;
  readonly spec: CompiledSpec;
  readonly target: Exclude<ScanTarget, { readonly kind: "rows" }>;
};

export type Unreadable = { readonly kind: "missing" } | { readonly kind: "spec-changed" } | Exclude<IndexState, { kind: "ready" }>;

export type BoundCollection = {
  readonly name: string;
  readonly id: CollectionId;
  readonly rows: Extract<ScanTarget, { readonly kind: "rows" }>;
  /** Every building or ready index in the catalog, declared by this handle or not. Writes keep exactly these. */
  readonly maintained: readonly IndexPlan[];
  /** Some maintained index is a count index, so writes tally groups. */
  readonly counted: boolean;
  /** By declared index name: the plan if this handle may query it, else why not. */
  readonly readable: ReadonlyMap<string, IndexPlan | Unreadable>;
};

export type Bound = {
  /** A write commits only if the stored catalog is still this write. */
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
    const plans = [...maintained.values()];
    const counted = plans.some((p) => p.target.kind === "count");
    collections.set(name, { name, id, rows: { kind: "rows", prefix: rows }, maintained: plans, counted, readable });
  }
  return { bytes, catalog, collections };
}

function compile(collection: CollectionId, rows: Uint8Array, name: string, i: StoredIndex): IndexPlan {
  const on = i.spec.on.map((p) => p.split("."));
  const spec: CompiledSpec =
    i.spec.kind === "sorted"
      ? { kind: "sorted", on, unique: i.spec.unique, multi: i.spec.multi, include: i.spec.include }
      : i.spec.kind === "count"
        ? { kind: "count", on, multi: i.spec.multi }
        : { kind: "text", on, text: i.spec.text.split(".") };
  const shape = { prefix: indexPrefix(collection, i.id as IndexId), arity: on.length, multi: spec.kind !== "text" && spec.multi };
  const target: IndexPlan["target"] =
    spec.kind === "count"
      ? { kind: "count", ...shape }
      : { kind: spec.kind === "text" ? "text" : spec.unique ? "unique" : spec.include ? "covering" : "sorted", rowPrefix: rows, ...shape };
  return { name, id: i.id as IndexId, state: i.state, spec, target };
}
