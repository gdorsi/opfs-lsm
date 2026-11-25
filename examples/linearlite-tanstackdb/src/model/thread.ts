import type { Body, Comment } from "../domain/model.ts";

/** The description and comments of an issue. `missing`: the server answered that it has no description. */
export type Thread =
  | { readonly kind: "loading" }
  | { readonly kind: "missing"; readonly comments: readonly Comment[] }
  | { readonly kind: "ready"; readonly body: Body; readonly comments: readonly Comment[] };

type Read<T> = { readonly data: T; readonly isReady: boolean };

/** The thread the live queries `bodyOf` and `commentsOf` read. `answered`: the server answered a fetch of it. */
export function threadOf(body: Read<Body | undefined>, comments: Read<readonly Comment[]>, answered: boolean): Thread {
  if (!body.isReady || !comments.isReady) return { kind: "loading" };
  if (body.data) return { kind: "ready", body: body.data, comments: comments.data };
  return answered ? { kind: "missing", comments: comments.data } : { kind: "loading" };
}
