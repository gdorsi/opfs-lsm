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
/** Paths to an array of scalars: the first path of a `multi` index. */
type ArrayPath<T> = PathTo<T, readonly Scalar[]>;
/** Paths to a string: the `text` of a text index. */
type StringPath<T> = PathTo<T, string>;

type At<T, P extends string> = P extends `${infer H}.${infer R}`
  ? At<Defined<T[H & keyof T]>, R>
  : Defined<T[P & keyof T]>;

type Paths<P> = P | readonly [P, ...P[]];

/**
 * One index of a collection. Three kinds, told apart by their fields:
 *
 * - sorted, `{ on, unique? }`: one entry per document, ordered by the values
 *   at `on`, then the id.
 * - multi, `{ on, multi: true, unique? }`: the first path of `on` holds an
 *   array; one entry per distinct element, each followed by the rest of `on`.
 * - text, `{ on, text }`: a sorted index on `on` whose entries also carry the
 *   words of the string at `text`, for `query({ match })`.
 */
export type IndexDecl<T> =
  | {
      readonly on: Paths<ScalarPath<T>>;
      readonly unique?: boolean;
      readonly multi?: false;
      readonly text?: undefined;
    }
  | {
      readonly on: ArrayPath<T> | readonly [ArrayPath<T>, ...ScalarPath<T>[]];
      readonly multi: true;
      readonly unique?: boolean;
      readonly text?: undefined;
    }
  | {
      readonly on: Paths<ScalarPath<T>>;
      readonly text: StringPath<T>;
      readonly unique?: false;
      readonly multi?: false;
    };

type IndexDecls<T> = { readonly [index: string]: IndexDecl<T> };

type SchemaDecl<Docs extends DocsMap> = {
  /** An integer >= 1, bumped on every change to `collections`. */
  readonly version: number;
  readonly collections: { readonly [C in keyof Docs]: IndexDecls<Docs[C]> };
  /**
   * Collections to delete, with every document and index, when this version
   * is stored. A collection only left out of `collections` is kept.
   */
  readonly drop?: readonly string[];
};

declare const docsType: unique symbol;

/** A declared schema that remembers its document types. Made by `defineSchema`. */
export type Schema<Docs extends DocsMap = DocsMap, Decl extends SchemaDecl<Docs> = SchemaDecl<Docs>> = Decl & {
  readonly [docsType]?: Docs;
};

/**
 * Curried so the document types are given and the declaration is inferred
 * with literal paths, which the query types read.
 *
 *     defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: { byCreated: { on: "createdAt" } } } })
 */
export function defineSchema<Docs extends DocsMap>(): <const Decl extends SchemaDecl<Docs>>(
  schema: Decl,
) => Schema<Docs, Decl> {
  return (schema) => schema;
}

/** What `openDocStore` accepts. Looser than `Schema`: `defineSchema` already checked the paths. */
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
  /** The dot paths the index orders by. */
  readonly on: readonly string[];
  readonly unique: boolean;
  /** The dot path of a text index's words. */
  readonly text?: string;
};

declare const cursorBrand: unique symbol;

/**
 * Opaque position in one index's order. Exclusive: the next page starts
 * after it (before it, with `reverse`).
 */
export type Cursor = string & { readonly [cursorBrand]: true };

type OnTuple<D> = D extends { readonly on: infer On } ? (On extends string ? readonly [On] : On) : never;

type ValuesAt<T, Ps> = { -readonly [K in keyof Ps]: At<T, Ps[K] & string> };
type ElementOf<A> = A extends readonly (infer E)[] ? E : never;

/** The value tuple an index orders by. A multi index's first component is the element type. */
type ValuesOf<T, D> = D extends { readonly multi: true }
  ? OnTuple<D> extends readonly [infer F extends string, ...infer R]
    ? [ElementOf<At<T, F>>, ...ValuesAt<T, R>]
    : never
  : ValuesAt<T, OnTuple<D>>;

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
