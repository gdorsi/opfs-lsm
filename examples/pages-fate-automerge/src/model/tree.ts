/**
 * The page tree on fate: the entity, its views, roots and mutations, and the
 * commands the app, the bench and the tests call. fate owns the tree and the
 * titles; the bodies live in Automerge (bodies.ts).
 */
import type { PageId } from "./types.ts";

/** fate's persistence key and the server's receipt scope, which fate requires to be equal. One workspace per server. */
export const PERSISTENCE_KEY = "pages:workspace";
export const MAX_TITLE = 500;
/** A sidebar level asks for this many children at a time. */
export const CHILDREN_PAGE = 200;

/** No rank and no timestamps: siblings are in creation order until pages can move. */
export type PageEntity = {
  readonly __typename: "Page";
  readonly id: PageId;
  readonly parentId: PageId | null;
  readonly title: string;
};

export type NewPage = { readonly id: PageId; readonly parentId: PageId | null; readonly title: string };
export type Rename = { readonly id: PageId; readonly title: string };
