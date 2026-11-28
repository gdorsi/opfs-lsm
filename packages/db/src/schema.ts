/*
 * Declaring a collection, and `prepare`, the one function every write
 * passes through. The validator stays here: docstore is opened without one.
 */
import { collection as docstoreCollection, type CollectionDecl, type IndexInfo, type Schema } from "@opfs-lsm/docstore";
import { SchemaError, ValidationError } from "./errors.js";
import { fieldAt, isScalar } from "./expr.js";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json | undefined };

/** A document: a JSON object with a string `id`. Declare its type with `type`, since an `interface` has no index signature. */
export type JsonDoc = { readonly id: string; readonly [key: string]: Json | undefined };

/** The Standard Schema v1 interface (standardschema.dev), copied as its spec invites, so validating needs no dependency. */
interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}
type StandardResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly StandardIssue[] };
export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}
type Validator = StandardSchemaV1<unknown, JsonDoc>;
type InferInput<V extends Validator> = NonNullable<V["~standard"]["types"]>["input"];
type InferOutput<V extends Validator> = NonNullable<V["~standard"]["types"]>["output"];

type Fields<T extends JsonDoc> = Parameters<CollectionDecl<T>["unique"]>[1];
type TextArgs<T extends JsonDoc> = Parameters<CollectionDecl<T>["text"]>;

declare const types: unique symbol;

type Fresh<Names, N extends string> = N extends Names ? "an index of this name is already declared" : N;

/**
 * A collection: its stored document `T`, and what a write takes, `In`, which
 * differs when the validator has defaults or transforms. Each method adds an
 * index and returns a new declaration, so a base can be shared.
 *
 * `by` is a field, a dot path such as `"meta.due"`, or a list of them. An
 * index is ordered by the values at `by`, then by id.
 */
export interface CollectionDef<T extends JsonDoc, In = T, Names extends string = never> {
  readonly [types]: { readonly doc: T; readonly input: In };
  /** A sorted index. A first field written `"tags[]"` indexes each element of an array, and no query reads such an index yet. */
  index<const N extends string>(name: Fresh<Names, N>, by: Fields<T>): CollectionDef<T, In, Names | N>;
  /** A sorted index in which no two documents share the values at `by`. */
  unique<const N extends string>(name: Fresh<Names, N>, by: Fields<T>): CollectionDef<T, In, Names | N>;
  /** A sorted index that also holds the words of the string field `text`, which `like` and `ilike` on that field search. */
  text<const N extends string>(name: Fresh<Names, N>, by: TextArgs<T>[1], text: TextArgs<T>[2]): CollectionDef<T, In, Names | N>;
}

type Decl = {
  index(name: string, by: unknown): Decl;
  unique(name: string, by: unknown): Decl;
  text(name: string, by: unknown, text: unknown): Decl;
};

/** docstore's own declaration, grown by its own methods, next to the validator docstore never sees. */
class Def {
  constructor(
    readonly decl: Decl,
    readonly validator: Validator | undefined,
  ) {}
  index(name: string, by: unknown): Def {
    return new Def(this.decl.index(name, by), this.validator);
  }
  unique(name: string, by: unknown): Def {
    return new Def(this.decl.unique(name, by), this.validator);
  }
  text(name: string, by: unknown, text: unknown): Def {
    return new Def(this.decl.text(name, by, text), this.validator);
  }
}

/**
 * Start the declaration of a collection, with a validator or with the type
 * of its documents. A validator is any Standard Schema (valibot, zod,
 * arktype...): documents are then its outputs, and a write takes its input.
 *
 *     collection(Issue).index("byCreated", "created")
 *     collection<Issue>().index("byCreated", "created")
 */
export function collection<V extends Validator>(validator: V): CollectionDef<InferOutput<V>, InferInput<V>>;
export function collection<T extends JsonDoc>(): CollectionDef<T>;
export function collection(validator?: Validator): never {
  return new Def(docstoreCollection<JsonDoc>() as unknown as Decl, validator) as never;
}

export type Collections = { readonly [name: string]: { readonly [types]: unknown } };
export type DocOf<D> = D extends { readonly [types]: { readonly doc: infer T extends JsonDoc } } ? T : never;
export type InputOf<D> = D extends { readonly [types]: { readonly input: infer In } } ? In : never;

/** The docstore schema of `collections`: their indexes, and no validator. */
export function docstoreSchema(version: number, collections: Collections): Schema {
  const decls: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(collections)) {
    if (!(def instanceof Def)) throw new SchemaError("catalog", `collection "${name}" was not made by collection()`);
    decls[name] = def.decl;
  }
  return { version, collections: decls as Schema["collections"] };
}

/** What `prepare` checks for one collection, derived once at open from its indexes. */
export type WriteRules = {
  readonly name: string;
  readonly validator: Validator | undefined;
  /** The fields that every sorted and text index orders by. */
  readonly scalarPaths: readonly (readonly string[])[];
  /** The field whose words each text index holds. */
  readonly textPaths: readonly (readonly string[])[];
};

/** `def` is a declaration `docstoreSchema` accepted, and `indexes` are its indexes as the opened collection lists them. */
export function writeRules(name: string, def: unknown, indexes: Iterable<IndexInfo>): WriteRules {
  const scalar = new Set<string>();
  const text = new Set<string>();
  for (const info of indexes) {
    // No plan reads a multi index, so a document may be absent from one.
    if (info.kind === "multi") continue;
    for (const field of info.by) scalar.add(field);
    if (info.text !== undefined) text.add(info.text);
  }
  const split = (paths: Set<string>) => Array.from(paths, (p) => p.split("."));
  return { name, validator: (def as Def).validator, scalarPaths: split(scalar), textPaths: split(text) };
}

const MAX_ID_BYTES = 1024;

/** An id a document can have: not empty, no lone surrogate, at most 1,024 UTF-8 bytes. The storage refuses any other. */
export function isId(id: unknown): id is string {
  return typeof id === "string" && id !== "" && id.isWellFormed() && (id.length * 3 <= MAX_ID_BYTES || new TextEncoder().encode(id).length <= MAX_ID_BYTES);
}

const isText = (v: unknown) => v === null || typeof v === "string";

/**
 * The document a write stores, or a ValidationError. Synchronous and pure,
 * so it can run inside a read-modify-write that may run it again.
 *
 * It requires a value, null allowed, at every field a sorted or text index
 * names. So every document has an entry in each of those indexes: any of
 * them reaches every document a `where` accepts, and a document with no
 * entry in one before a change did not exist before it.
 */
export function prepare(rules: WriteRules, input: unknown): JsonDoc {
  const { name, validator } = rules;
  let doc = input;
  if (validator) {
    const result = validator["~standard"].validate(input);
    const id = fieldAt(input, ["id"]);
    const given = typeof id === "string" ? id : undefined;
    if (result instanceof Promise) {
      // The write fails here, so a rejection of the Promise would reach nobody.
      result.catch(() => {});
      throw new ValidationError("async", `"${name}": the validator must be synchronous`, name, given);
    }
    if (result.issues) throw new ValidationError("invalid", `"${name}": ${result.issues[0]?.message}`, name, given, result.issues);
    doc = result.value;
  }
  const id = fieldAt(doc, ["id"]);
  if (!isId(id)) throw new ValidationError("id", `"${name}": a document needs an id that is a non-empty string of at most ${MAX_ID_BYTES} bytes`, name);
  const need = (paths: readonly (readonly string[])[], holds: (v: unknown) => boolean, what: string) => {
    for (const path of paths) {
      if (holds(fieldAt(doc, path))) continue;
      throw new ValidationError("indexed-field", `"${name}": "${path.join(".")}" of "${id}" is indexed, so it must hold ${what}`, name, id);
    }
  };
  need(rules.scalarPaths, isScalar, "null, a boolean, a finite number or a string");
  need(rules.textPaths, isText, "a string or null");
  return doc as JsonDoc;
}
