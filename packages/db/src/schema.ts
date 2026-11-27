export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json | undefined };

/** A document: a JSON object with a string `id`. Declare its type with `type`, since an `interface` has no index signature. */
export type JsonDoc = { readonly id: string; readonly [key: string]: Json | undefined };

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

const MAX_ID_BYTES = 1024;

/** An id a document can have: not empty, no lone surrogate, at most 1,024 UTF-8 bytes. The storage refuses any other. */
export function isId(id: unknown): id is string {
  return typeof id === "string" && id !== "" && id.isWellFormed() && (id.length * 3 <= MAX_ID_BYTES || new TextEncoder().encode(id).length <= MAX_ID_BYTES);
}
