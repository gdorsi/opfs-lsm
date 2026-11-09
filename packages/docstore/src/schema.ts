/** What an index component can hold: JSON's scalars, ordered null < false < true < numbers < strings. */
export type Scalar = null | boolean | number | string;

declare const cursorBrand: unique symbol;

/**
 * Opaque position in one index's order. Exclusive: the next page starts
 * after it (before it, with `reverse`).
 */
export type Cursor = string & { readonly [cursorBrand]: true };

/** The runtime shape of every query, before the `Query` types narrow it. */
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
