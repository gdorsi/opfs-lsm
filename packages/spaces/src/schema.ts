/**
 * Schemas: collections of fields, each field one validator.
 *
 * The shape of a collection is a record of per-field validators, not one
 * object schema. That is the merge model: the store merges field by field
 * (last write wins per field), so a rule that spans two fields could not
 * hold after a merge of two valid writes. The schema cannot express one
 * (encode-lessons-in-structure).
 *
 * A validator is anything that implements Standard Schema v1: zod 4,
 * zod/mini, valibot, arktype. This package imports none of them, so the
 * app's zod is the only copy in the bundle. Validation must be
 * synchronous: a validator that returns a Promise makes the write throw
 * SpacesError "validation", because writes validate before the kv
 * transaction (see `db.ts` `transact`).
 *
 * Validators must be idempotent: the output is itself a valid input and
 * maps to itself. A local write stores the output, a remote apply stores
 * the wire value when the validator accepts it, and the upgrade pass checks
 * stored values again, so a transform that is not idempotent makes devices
 * hold different values under one stamp. The output must be JSON, which the
 * types enforce: `z.date()` is a compile error. Use `z.iso.datetime()` or a
 * number for dates.
 *
 * Across versions a validator may loosen: records that held values the old
 * one refused become readable after the version bump. Tightening one hides
 * the records that now fail it (their cells are kept, invalid, and sync
 * on), so a tightening needs a migration that rewrites the values first.
 * A version bump stays required for any change to a declaration.
 */

import { SpacesError } from "./errors.js";
import type { FileRef } from "./files.js";
import { isIdText } from "./ids.js";
import type { RecordId, SpaceId } from "./ids.js";
import type { BoundField, FieldValidation } from "./local/store.js";
import type { Json } from "./local/record.js";

// ---------------------------------------------------------------------------
// Standard Schema v1, as types only (https://standardschema.dev)

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly { readonly message: string }[] };

type InputOf<S> = S extends { readonly "~standard": { readonly types?: infer T } }
  ? NonNullable<T> extends { readonly input: infer I }
    ? I
    : unknown
  : never;
type OutputOf<S> = S extends { readonly "~standard": { readonly types?: infer T } }
  ? NonNullable<T> extends { readonly output: infer O }
    ? O
    : unknown
  : never;

// ---------------------------------------------------------------------------
// Field kinds the store treats specially

/** Runtime tag on the package's own field kinds. A symbol, so no validator library can collide with it. */
export const FIELD: unique symbol = Symbol("opfs-lsm.field");

/**
 * A reference to a record of collection `Target`, stored as its id string
 * and merged like any field. Named by collection name, not by a thunk, so
 * two collections can reference each other without a type cycle.
 * `defineSchema` checks that `Target` is a collection of the schema.
 */
export interface RefField<Target extends string, Optional extends boolean>
  extends StandardSchemaV1<
    Optional extends true ? RecordId<Target> | undefined : RecordId<Target>,
    Optional extends true ? RecordId<Target> | undefined : RecordId<Target>
  > {
  readonly [FIELD]: "ref";
  readonly target: Target;
  optional(): RefField<Target, true>;
}

/**
 * An immutable encrypted blob, made by `db.files.put`. The value is a
 * `FileRef`, which carries the file's own key, so the record's encryption
 * covers the key. The blob belongs to the first record that references it
 * and is deleted with that record.
 */
export interface FileField<Optional extends boolean>
  extends StandardSchemaV1<
    Optional extends true ? FileRef | undefined : FileRef,
    Optional extends true ? FileRef | undefined : FileRef
  > {
  readonly [FIELD]: "file";
  optional(): FileField<true>;
}

/**
 * A Yjs document attached to the record, for rich text or any Y type. It
 * is not part of the row: open it with `db.<collection>.open(id, field)`.
 * It merges with Yjs and syncs as its own update stream (`richtext.ts`).
 * It exists exactly as long as its record.
 */
export interface RichTextField {
  readonly [FIELD]: "richText";
}

const issue = (message: string): StandardResult<never> => ({ issues: [{ message }] });

/**
 * The factories below build objects whose `~standard.validate` accepts
 * exactly the values the branded output types stand for, so each casts once
 * to its public type.
 */
function makeRef<Target extends string, Optional extends boolean>(target: Target, optional: Optional): RefField<Target, Optional> {
  const field = {
    [FIELD]: "ref",
    target,
    optional: () => makeRef(target, true),
    "~standard": {
      version: 1,
      vendor: "opfs-lsm",
      validate: (value: unknown) =>
        value === undefined && optional ? { value } : isIdText(value) ? { value } : issue(`expected a ${target} id`),
    },
  };
  return field as unknown as RefField<Target, Optional>;
}

function makeFile<Optional extends boolean>(optional: Optional): FileField<Optional> {
  const field = {
    [FIELD]: "file",
    optional: () => makeFile(true),
    "~standard": {
      version: 1,
      vendor: "opfs-lsm",
      validate: (value: unknown) => {
        if (value === undefined && optional) return { value };
        const v = value as Partial<Record<keyof FileRef, unknown>> | null;
        if (
          typeof v !== "object" ||
          v === null ||
          !isIdText(v.id) ||
          typeof v.name !== "string" ||
          typeof v.type !== "string" ||
          !Number.isSafeInteger(v.size) ||
          (v.size as number) < 0 ||
          typeof v.key !== "string" ||
          v.key === ""
        ) {
          return issue("expected a FileRef made by files.put");
        }
        return { value: { id: v.id, name: v.name, type: v.type, size: v.size, key: v.key } };
      },
    },
  };
  return field as unknown as FileField<Optional>;
}

export function ref<const Target extends string>(target: Target): RefField<Target, false> {
  return makeRef(target, false);
}
export function file(): FileField<false> {
  return makeFile(false);
}
export function richText(): RichTextField {
  return { [FIELD]: "richText" };
}

/** What a shape entry is, as the store treats it. */
export function fieldKind(def: FieldDef): "value" | "ref" | "file" | "richText" {
  const tag: unknown = Reflect.get(def, FIELD);
  return tag === "ref" || tag === "file" || tag === "richText" ? tag : "value";
}

/**
 * Binds one validator for the store: runs it synchronously (a Promise or a
 * throw is a failure), and records what `validate(undefined)` says, so a
 * field with a default reads as its default on records that have no cell.
 */
export function bindField(name: string, def: StandardSchemaV1, kind: "value" | "ref" | "file"): BoundField {
  const validate = (value: unknown): FieldValidation => {
    let result: ReturnType<StandardSchemaV1["~standard"]["validate"]>;
    try {
      result = def["~standard"].validate(value);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (result instanceof Promise) return { ok: false, message: `the validator of "${name}" must be synchronous` };
    if (result.issues !== undefined) return { ok: false, message: result.issues.map((i) => i.message).join("; ") };
    return { ok: true, value: result.value as Json | undefined };
  };
  const probe = validate(undefined);
  const fallback: BoundField["fallback"] = !probe.ok
    ? { kind: "required" }
    : probe.value === undefined
      ? { kind: "absent" }
      : { kind: "default", value: probe.value };
  return { name, kind, fallback, validate };
}

// ---------------------------------------------------------------------------
// Collections

export type FieldDef = StandardSchemaV1 | RichTextField;
export type Shape = { readonly [field: string]: FieldDef };

/** What an index component holds. Order: null < false < true < numbers < strings (the docstore tuple order). */
export type Scalar = null | boolean | number | string;

type DataKeys<S extends Shape> = { [K in keyof S]: S[K] extends RichTextField ? never : K }[keyof S] & string;
export type RichTextKeys<S extends Shape> = { [K in keyof S]: S[K] extends RichTextField ? K : never }[keyof S] &
  string;
type RefKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends RefField<string, boolean> ? K : never;
}[keyof S] &
  string;
type TargetOf<F> = F extends RefField<infer T, boolean> ? T : never;

/** Fields whose value, minus `undefined`, is a scalar: what an index may name. */
type ScalarKeys<S extends Shape> = {
  [K in DataKeys<S>]: Exclude<OutputOf<S[K]>, undefined> extends Scalar ? K : never;
}[DataKeys<S>];

/** An index orders the collection by these fields, then by record id. A missing optional value sorts as null. */
export type IndexDecls<S extends Shape> = {
  readonly [index: string]: readonly [ScalarKeys<S>, ...ScalarKeys<S>[]];
};

export type CollectionDef<N extends string = string, S extends Shape = Shape, Ix = unknown> = {
  readonly name: N;
  readonly shape: S;
  readonly indexes: Ix;
};

export type AnyCollection = CollectionDef<string, Shape, unknown>;

/** JSON, where an object property may also be undefined (JSON drops it), as zod writes an optional one. */
type JsonOutput = Json | undefined | { readonly [key: string]: JsonOutput } | readonly JsonOutput[];

/** `unknown` for a field whose output is JSON; otherwise an object the caller's validator lacks, so the compiler names the field. */
type JsonShape<S extends Shape> = {
  readonly [K in keyof S]: S[K] extends RichTextField
    ? unknown
    : [OutputOf<S[K]>] extends [JsonOutput]
      ? unknown
      : { readonly error: `field "${K & string}" must output JSON: use z.iso.datetime() or a number for dates` };
};

export function collection<
  const N extends string,
  const S extends Shape,
  const Ix extends IndexDecls<S> = {},
>(name: N, shape: S & JsonShape<S>, options?: { readonly indexes?: Ix }): CollectionDef<N, S, Ix> {
  // With no indexes declared, `Ix` is its `{}` default.
  return { name, shape, indexes: (options?.indexes ?? {}) as Ix };
}

// ---------------------------------------------------------------------------
// Rows, inputs, patches

type Flatten<T> = { [K in keyof T]: T[K] } & {};

/** What a read returns. Never validated on read: only valid values are stored in the fields a read parses (`local/record.ts`). */
export type Row<C extends AnyCollection> = Flatten<
  { readonly id: RecordId<C["name"]> } & { readonly [K in DataKeys<C["shape"]>]: OutputOf<C["shape"][K]> }
>;

type OptionalInputKeys<S extends Shape> = {
  [K in DataKeys<S>]: undefined extends InputOf<S[K]> ? K : never;
}[DataKeys<S>];
type RequiredInputKeys<S extends Shape> = Exclude<DataKeys<S>, OptionalInputKeys<S>>;

/** What `create` takes. A field whose validator accepts `undefined` (optional, or with a default) may be left out. */
export type Input<C extends AnyCollection> = Flatten<
  { readonly [K in RequiredInputKeys<C["shape"]>]: InputOf<C["shape"][K]> } & {
    readonly [K in OptionalInputKeys<C["shape"]>]?: InputOf<C["shape"][K]>;
  }
>;

/**
 * What `update` takes: the fields to set. Each one is validated on its own
 * and merged on its own. `undefined` unsets an optional field, which is a
 * write with a stamp like any other.
 */
export type Patch<C extends AnyCollection> = {
  readonly [K in DataKeys<C["shape"]>]?: InputOf<C["shape"][K]>;
};

// ---------------------------------------------------------------------------
// Schema

export type SchemaDef<Cs extends readonly AnyCollection[] = readonly AnyCollection[]> = {
  /** An integer >= 1. Bump it when collections or indexes change: the stored catalog follows the highest version any tab has opened. */
  readonly version: number;
  readonly collections: Cs;
};

/** Names the database handle uses itself, derived from its type in `db.ts`, so the two lists cannot drift. */
type ReservedName = import("./db.js").ReservedName;

type Names<Cs extends readonly AnyCollection[]> = Cs[number]["name"];
type UnknownRefs<Cs extends readonly AnyCollection[]> = {
  [I in keyof Cs]: Cs[I] extends AnyCollection
    ? Exclude<TargetOf<Cs[I]["shape"][RefKeys<Cs[I]["shape"]>]>, Names<Cs>>
    : never;
}[number];

/** `unknown` when the schema is fine; otherwise an object with an `error` the caller's literal lacks, so the compiler names the problem. */
type CheckSchema<Cs extends readonly AnyCollection[]> = [UnknownRefs<Cs>] extends [never]
  ? [Extract<Names<Cs>, ReservedName>] extends [never]
    ? unknown
    : { readonly error: `collection name "${Extract<Names<Cs>, ReservedName>}" is reserved` }
  : { readonly error: `ref to a collection the schema lacks: "${UnknownRefs<Cs>}"` };

/**
 * Checks the declarations once, at definition: ref targets exist, names
 * are unique and not reserved, index fields are scalar fields. The same
 * checks run again at runtime and throw SpacesError "schema".
 */
const RESERVED = ["account", "spaces", "files", "sync", "transact", "close"] as const satisfies readonly ReservedName[];
// The list above must name every member of the handle, and only those.
const reservedListIsComplete: ReservedName extends (typeof RESERVED)[number] ? true : never = true;
void reservedListIsComplete;

/** Field names the row object keeps for itself. */
const RESERVED_FIELDS: readonly string[] = ["id", "__proto__"];
const MAX_COLLECTIONS = 255;
const MAX_INDEXES = 255;

function bad(message: string): never {
  throw new SpacesError("schema", message);
}

export function defineSchema<const Cs extends readonly AnyCollection[]>(
  schema: SchemaDef<Cs> & CheckSchema<Cs>,
): SchemaDef<Cs> {
  if (!Number.isInteger(schema.version) || schema.version < 1) bad("version must be an integer >= 1");
  if (schema.collections.length > MAX_COLLECTIONS) bad(`a schema has at most ${MAX_COLLECTIONS} collections`);
  const names = new Set<string>();
  for (const c of schema.collections) {
    if (typeof c.name !== "string" || c.name === "") bad("a collection needs a name");
    if ((RESERVED as readonly string[]).includes(c.name)) bad(`collection name "${c.name}" is reserved`);
    if (names.has(c.name)) bad(`collection "${c.name}" is declared twice`);
    names.add(c.name);
  }
  for (const c of schema.collections) {
    const fields = new Map<string, FieldDef>(Object.entries(c.shape));
    for (const [name, def] of fields) {
      const where = `${c.name}.${name}`;
      if (RESERVED_FIELDS.includes(name)) bad(`${where}: "${name}" is not a usable field name`);
      const kind = typeof def === "object" && def !== null ? fieldKind(def) : undefined;
      if (kind === undefined) bad(`${where}: a field is a Standard Schema validator, ref, file or richText`);
      if (kind === "value" && typeof (def as StandardSchemaV1)["~standard"]?.validate !== "function") {
        bad(`${where}: not a Standard Schema validator`);
      }
      if (kind === "ref") {
        const target: unknown = Reflect.get(def, "target");
        if (typeof target !== "string" || !names.has(target)) bad(`${where}: ref to a collection the schema lacks: "${String(target)}"`);
      }
    }
    const indexes = Object.entries((c.indexes ?? {}) as Record<string, readonly string[]>);
    if (indexes.length > MAX_INDEXES) bad(`${c.name} has more than ${MAX_INDEXES} indexes`);
    for (const [index, by] of indexes) {
      const where = `${c.name} index "${index}"`;
      if (index === "") bad(`${c.name}: an index needs a name`);
      if (!Array.isArray(by) || by.length === 0) bad(`${where}: name at least one field`);
      if (new Set(by).size !== by.length) bad(`${where}: a field is named twice`);
      for (const f of by) {
        const def = fields.get(f);
        if (def === undefined) bad(`${where}: "${f}" is not a field`);
        if (fieldKind(def) === "richText") bad(`${where}: "${f}" is a rich-text field`);
      }
    }
  }
  return schema;
}

export type CollectionNamed<Cs extends readonly AnyCollection[], N extends string> = Extract<
  Cs[number],
  { readonly name: N }
>;

// ---------------------------------------------------------------------------
// Queries

declare const cursorBrand: unique symbol;
/** Opaque, exclusive position in one index's order. */
export type Cursor = string & { readonly [cursorBrand]: true };

type IndexValues<S extends Shape, Fs> = {
  -readonly [K in keyof Fs]: Fs[K] extends keyof S
    ? Exclude<OutputOf<S[Fs[K]]>, undefined> | (undefined extends OutputOf<S[Fs[K]]> ? null : never)
    : never;
};

type Bound<H> = {
  readonly gt?: H | undefined;
  readonly gte?: H | undefined;
  readonly lt?: H | undefined;
  readonly lte?: H | undefined;
  readonly startsWith?: ([H] extends [string] ? string : never) | undefined;
};
type EqOf<E extends readonly unknown[]> = E extends readonly []
  ? { readonly eq?: readonly [] | undefined }
  : { readonly eq: Readonly<E> };

/** One member per k: `eq` fixes the first k components, the bound has the type of component k + 1 (docstore's `Where`). */
type Where<V extends readonly unknown[], E extends readonly unknown[] = []> = V extends readonly [
  infer H,
  ...infer R,
]
  ? (EqOf<E> & Bound<H>) | Where<R, [...E, H]>
  : EqOf<E> & Bound<never>;

type PageOptions<C extends AnyCollection> = {
  readonly limit?: number | undefined;
  readonly after?: Cursor | undefined;
  readonly reverse?: boolean | undefined;
  /**
   * A predicate on decoded rows, run after the index range. `limit` counts
   * rows that pass. For small collections this replaces a query planner.
   */
  readonly filter?: ((row: Row<C>) => boolean) | undefined;
};

/** All records of the collection, or of one space, in id order: a prefix scan, no index. */
type ScanQuery<C extends AnyCollection> = {
  readonly index?: undefined;
  readonly space?: SpaceId | undefined;
} & PageOptions<C>;

type IndexQuery<C extends AnyCollection> = {
  [I in keyof C["indexes"] & string]: { readonly index: I; readonly space?: undefined } & Where<
    IndexValues<C["shape"], C["indexes"][I]> extends readonly unknown[]
      ? IndexValues<C["shape"], C["indexes"][I]>
      : never
  > &
    PageOptions<C>;
}[keyof C["indexes"] & string];

export type Query<C extends AnyCollection> = ScanQuery<C> | IndexQuery<C>;

/**
 * Which refs to load with the row, Jazz's `resolve`, without its
 * dependency chains: each level is one `getMany` in the same kv snapshot.
 * `true` loads the target row; an object resolves the target's own refs.
 */
export type ResolveSpec<Cs extends readonly AnyCollection[], C extends AnyCollection> = {
  readonly [K in RefKeys<C["shape"]>]?:
    | true
    | ResolveSpec<Cs, CollectionNamed<Cs, TargetOf<C["shape"][K]>>>;
};

/** `Row<C>` with each resolved ref replaced by its row. `undefined` when the target is missing, deleted, unreadable, or in a space this account cannot read. */
export type Resolved<Cs extends readonly AnyCollection[], C extends AnyCollection, R> = Flatten<
  Omit<Row<C>, keyof R & string> & {
    readonly [K in keyof R & RefKeys<C["shape"]>]:
      | (R[K] extends true
          ? Row<CollectionNamed<Cs, TargetOf<C["shape"][K]>>>
          : Resolved<Cs, CollectionNamed<Cs, TargetOf<C["shape"][K]>>, R[K]>)
      | undefined;
  }
>;

export type Page<T> = { readonly rows: T[]; readonly next?: Cursor };
