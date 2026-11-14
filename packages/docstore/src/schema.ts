export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

/** What an index component can hold: JSON's scalars, ordered null < false < true < numbers < strings. */
export type Scalar = null | boolean | number | string;

/**
 * A document: a JSON object with a string `id`. Declare document types with
 * `type`, not `interface`: only type literals get the implicit index
 * signature this constraint needs. A `Date`, `Map`, `Uint8Array` or class
 * instance fails it, because JSON would not give it back.
 */
export type JsonDoc = { readonly id: string; readonly [key: string]: Json | undefined };

type DocsMap = { readonly [collection: string]: JsonDoc };

/** Recursion budget: three levels of nesting. */
type Budget = [never, 0, 1, 2];
type Defined<V> = Exclude<V, undefined>;

/** Dot paths of `T` whose value, minus `undefined`, extends `Leaf`. Arrays are leaves or nothing: no path enters one. */
type PathTo<T, Leaf, D extends number = 3> = [D] extends [never]
  ? never
  : {
      [K in keyof T & string]-?: Defined<T[K]> extends Leaf
        ? K
        : Defined<T[K]> extends readonly unknown[]
          ? never
          : Defined<T[K]> extends object
            ? `${K}.${PathTo<Defined<T[K]>, Leaf, Budget[D]>}`
            : never;
    }[keyof T & string];

/** Paths to a scalar. */
type ScalarPath<T> = PathTo<T, Scalar>;
/** Paths to an array of scalars: the first field of a multi index, written with a `[]` suffix. */
type ArrayPath<T> = PathTo<T, readonly Scalar[]>;
/** Paths to a string: the `text` of a text index. */
type StringPath<T> = PathTo<T, string>;

type At<T, P extends string> = P extends `${infer H}.${infer R}`
  ? At<Defined<T[H & keyof T]>, R>
  : Defined<T[P & keyof T]>;

/** A scalar field, or an array field marked with `[]`. Only the first field may be an array field. */
type Fields<T> = readonly [ScalarPath<T> | `${ArrayPath<T>}[]`, ...ScalarPath<T>[]];

/**
 * One index of a collection, ordered by the values at `by`, then the id.
 *
 * - `by`: a field or a list of fields. An array field is written with a `[]`
 *   suffix and only the first may be one: the index then has one entry per
 *   distinct element, each followed by the rest of `by`.
 * - `unique`: no two documents share the values at `by`.
 * - `text`: a string field whose words the entries also carry, for
 *   `query({ match })`. Not with `unique`, nor with a `[]` first field.
 */
export type IndexDecl<T> = {
  readonly by: Fields<T> | Fields<T>[0];
  readonly unique?: boolean;
  readonly text?: StringPath<T>;
};

type Options = { readonly by?: unknown; readonly unique?: unknown; readonly text?: unknown };

/**
 * What a declaration must not be, as a type that fails with the reason: it
 * replaces the offending option by one that holds the message. The patterns
 * name every option, because an object literal type with a property the
 * pattern lacks does not extend it.
 */
type Rule<D> = D extends Options & { readonly text: string; readonly unique: true }
  ? Omit<D, "unique"> & { readonly unique: { readonly error: "a text index cannot be unique" } }
  : D extends Options & { readonly text: string; readonly by: `${string}[]` | readonly [`${string}[]`, ...unknown[]] }
    ? Omit<D, "by"> & { readonly by: "a text index cannot start with an array field" }
    : D;

type IndexDecls<T> = { readonly [index: string]: IndexDecl<T> };

type Collections<Docs extends DocsMap> = { readonly [C in keyof Docs]: IndexDecls<Docs[C]> };

/**
 * What the inferred collections must satisfy. A collection with no indexes
 * infers as `unknown`, which it also allows. An index with an option
 * `IndexDecl` lacks (`uniqe`) fails this, and TypeScript then checks the
 * declaration against `IndexDecl` itself, which names the option.
 */
type Declarable<Docs extends DocsMap, Cs> = {
  readonly [C in keyof Docs]: unknown extends (C extends keyof Cs ? Cs[C] : never) ? unknown : IndexDecls<Docs[C]>;
};

declare const docsType: unique symbol;

/** A declared schema that remembers its document types. Made by `defineSchema`. */
export type Schema<Docs extends DocsMap = DocsMap, Cs = Collections<Docs>> = {
  /** An integer >= 1, bumped on every change to `collections`. */
  readonly version: number;
  readonly collections: Cs;
  /**
   * Collections to delete, with every document and index, when this version
   * is stored. A collection only left out of `collections` is kept.
   */
  readonly drop?: readonly string[];
  readonly [docsType]?: Docs;
};

/** The collections as `defineSchema` takes them: each index is inferred, then checked against `Rule` and the `Docs` of its collection. */
type Checked<Docs extends DocsMap, Cs> = {
  readonly [C in keyof Cs]: { readonly [I in keyof Cs[C]]: Rule<Cs[C][I]> & IndexDecl<Docs[C & keyof Docs]> };
} & { readonly [C in Exclude<keyof Cs, keyof Docs>]: "not a collection of the document types" };

/** Inference through `Checked` leaves each index a fresh object literal, which an `extends` check rejects for a property it does not name. A copy is a plain object type. */
type Plain<Cs> = { readonly [C in keyof Cs]: { readonly [I in keyof Cs[C]]: { readonly [O in keyof Cs[C][I]]: Cs[C][I][O] } } };

/**
 * Curried so the document types are given and the declaration is inferred
 * with literal fields, which the query types read.
 *
 *     defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: { byCreated: { by: "createdAt" } } } })
 */
export function defineSchema<Docs extends DocsMap>(): <const Cs extends Declarable<Docs, Cs>>(
  schema: Schema<Docs, Checked<Docs, Cs>>,
) => Schema<Docs, Plain<Cs>> {
  return (schema) => schema as never;
}

/** What `openDocStore` accepts. Looser than `Schema`: `defineSchema` already checked the fields. */
export type AnySchema = {
  readonly version: number;
  readonly collections: { readonly [collection: string]: { readonly [index: string]: object } };
  readonly drop?: readonly string[];
  readonly [docsType]?: DocsMap;
};

type DocsOf<S> = S extends { readonly [docsType]?: infer D extends DocsMap } ? D : never;
export type CollectionName<S> = keyof DocsOf<S> & string;
export type DocOf<S, C extends CollectionName<S>> = DocsOf<S>[C];
export type IndexesOf<S, C extends string> = S extends { readonly collections: infer Cs }
  ? C extends keyof Cs
    ? Cs[C]
    : never
  : never;

/** What a declared index is, for layers that plan queries. */
export type IndexInfo = {
  readonly kind: "sorted" | "multi" | "text";
  /** The fields the index orders by, as declared. The first field of a multi index ends in `[]`. */
  readonly by: readonly string[];
  readonly unique: boolean;
  /** The field whose words a text index carries. */
  readonly text?: string;
};

declare const cursorBrand: unique symbol;

/**
 * Opaque position in one index's order. Exclusive: the next page starts
 * after it (before it, with `reverse`).
 */
export type Cursor = string & { readonly [cursorBrand]: true };

type ByTuple<D> = D extends { readonly by: infer B } ? (B extends string ? readonly [B] : B) : never;

type ValuesAt<T, Ps> = { -readonly [K in keyof Ps]: At<T, Ps[K] & string> };
type ElementOf<A> = A extends readonly (infer E)[] ? E : never;

/** The value tuple an index orders by. A `[]` first field contributes the element type of its array. */
type ValuesOf<T, D> = ByTuple<D> extends readonly [infer F extends string, ...infer R]
  ? F extends `${infer A}[]`
    ? [ElementOf<At<T, A>>, ...ValuesAt<T, R>]
    : ValuesAt<T, ByTuple<D>>
  : never;

/** A bound on one component. `startsWith` only for string components. `Bound<never>` forbids every bound. */
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

/** One member per k: `eq` fixes the first k components and the bound has the type of component k + 1. */
type Where<V extends readonly unknown[], E extends readonly unknown[] = []> = V extends readonly [
  infer H,
  ...infer R,
]
  ? (EqOf<E> & Bound<H>) | Where<R, [...E, H]>
  : EqOf<E> & Bound<never>;

type PageOptions = {
  /** Most results to return. Absent: all of them. `count` stops at it. */
  readonly limit?: number | undefined;
  /** The `next` of the previous page. */
  readonly after?: Cursor | undefined;
  /** Descending order of the same range. */
  readonly reverse?: boolean | undefined;
};

type IndexQuery<I, V extends readonly unknown[], D> = { readonly index: I } & Where<V> &
  PageOptions &
  (D extends { readonly text: string }
    ? {
        /** Keep entries where every word of `match` occurs inside a word of the text. */
        readonly match?: string | undefined;
      }
    : { readonly match?: undefined });

/** No index: the rows in id order. The id is the one component. */
type RowsQuery = { readonly index?: undefined; readonly match?: undefined } & Where<readonly [string]> & PageOptions;

/** Everything `query`, `queryIds` and `count` accept for a collection with indexes `Ix`. */
export type Query<T, Ix> =
  | RowsQuery
  | {
      [I in keyof Ix & string]: IndexQuery<
        I,
        ValuesOf<T, Ix[I]> extends readonly unknown[] ? ValuesOf<T, Ix[I]> : never,
        Ix[I]
      >;
    }[keyof Ix & string];

export type Page<T> = { readonly docs: T[]; readonly next?: Cursor };
export type IdPage = { readonly ids: string[]; readonly next?: Cursor };

export type QueryInput = {
  readonly index?: string | undefined;
  readonly eq?: readonly Scalar[] | undefined;
  readonly gt?: Scalar | undefined;
  readonly gte?: Scalar | undefined;
  readonly lt?: Scalar | undefined;
  readonly lte?: Scalar | undefined;
  readonly startsWith?: string | undefined;
  readonly match?: string | undefined;
  readonly limit?: number | undefined;
  readonly after?: Cursor | undefined;
  readonly reverse?: boolean | undefined;
};
