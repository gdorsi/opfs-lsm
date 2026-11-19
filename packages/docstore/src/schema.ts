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
type By<T> = Fields<T> | Fields<T>[0];
type TextBy<T> = readonly [ScalarPath<T>, ...ScalarPath<T>[]] | ScalarPath<T>;

/** The error an index name already in use gets: the name is a parameter of a type that no string has. */
type Free<Ix, N extends string> = N extends keyof Ix ? "an index of this name is already declared" : N;

declare const docType: unique symbol;

/**
 * A collection's document type and its indexes, made by `collection` and
 * grown by one method per kind of index. Each method returns a new
 * declaration and leaves this one as it is, so a base can be shared.
 *
 * An index is ordered by the values at `by`, then the id. `by` is a field or
 * a list of fields. An array field is written with a `[]` suffix and only the
 * first may be one: the index then has one entry per distinct element, each
 * followed by the rest of `by`.
 */
export interface CollectionDecl<T extends JsonDoc, Ix = {}> {
  /** The indexes declared so far, by name, as the stored catalog reads them. */
  readonly indexes: Ix;
  readonly [docType]?: T;
  /** A sorted index. */
  index<const N extends string, const B extends By<T>>(
    name: Free<Ix, N>,
    by: B,
  ): CollectionDecl<T, Ix & { readonly [K in N]: { readonly by: B } }>;
  /** A sorted index in which no two documents share the values at `by`. */
  unique<const N extends string, const B extends By<T>>(
    name: Free<Ix, N>,
    by: B,
  ): CollectionDecl<T, Ix & { readonly [K in N]: { readonly by: B; readonly unique: true } }>;
  /**
   * A sorted index whose entries also carry the words of the string field
   * `text`, for `query({ match })`. `by` has no array field.
   */
  text<const N extends string, const B extends TextBy<T>, const X extends StringPath<T>>(
    name: Free<Ix, N>,
    by: B,
    text: X,
  ): CollectionDecl<T, Ix & { readonly [K in N]: { readonly by: B; readonly text: X } }>;
}

class Declaration {
  constructor(readonly indexes: object = {}) {}
  index(name: string, by: unknown, option?: object): never {
    return new Declaration({ ...this.indexes, [name]: { by, ...option } }) as never;
  }
  unique(name: string, by: unknown): never {
    return this.index(name, by, { unique: true });
  }
  text(name: string, by: unknown, text: unknown): never {
    return this.index(name, by, { text });
  }
}

/**
 * Start the declaration of a collection of documents of type `T`.
 *
 *     collection<Todo>().index("byCreated", "createdAt").text("search", "createdAt", "title")
 */
export function collection<T extends JsonDoc>(): CollectionDecl<T> {
  return new Declaration() as never;
}

/** What `openDocStore` takes. Each collection is what `collection` made. */
export type Schema = {
  /** An integer >= 1, bumped on every change to `collections`. */
  readonly version: number;
  readonly collections: { readonly [name: string]: CollectionDecl<any, any> };
  /**
   * Collections to delete, with every document and index, when this version
   * is stored. A collection only left out of `collections` is kept.
   */
  readonly drop?: readonly string[];
};

/** Returns `schema`, so a mistake in it shows here and not at `openDocStore`. */
export function defineSchema<S extends Schema>(schema: S): S {
  return schema;
}

/** A mapped type, so that a handle's document type for a generic collection name relates to the document types an app keeps by name. */
type DocsOf<S extends Schema> = {
  readonly [C in keyof S["collections"]]: S["collections"][C] extends { readonly [docType]?: infer T extends JsonDoc } ? T : never;
};

export type CollectionName<S extends Schema> = keyof S["collections"] & string;
export type DocOf<S extends Schema, C extends CollectionName<S>> = DocsOf<S>[C];
export type IndexesOf<S extends Schema, C extends CollectionName<S>> = S["collections"][C]["indexes"];

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

/** One index entry: its document's id and the values the index orders it by, in `by` order. A row's one value is its id. */
export type IndexEntry<V = Scalar[]> = { readonly id: string; readonly values: V };
export type EntryPage<V = Scalar[]> = { readonly entries: IndexEntry<V>[]; readonly next?: Cursor };
export type EntryValues<T, Ix, I> = I extends keyof Ix ? ValuesOf<T, Ix[I]> : [id: string];

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
