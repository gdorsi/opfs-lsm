import type { Collection } from "@tanstack/db";
import type { Body, Comment, Rows, StoredIssue, SyncState } from "../domain/model.ts";
import type { Stream } from "../domain/stores.ts";
import type { IssueFilter } from "./filter.ts";
import type { Unsubscribe } from "./live.ts";

/** A row of each store as the model reads and writes it. */
export interface StoreRows extends Rows {
  sync: SyncState;
}
export type StoreName = keyof StoreRows;

/** A row of each store's collection. An issue also carries the sort keys its backend derives from its fields (`stored`). */
export interface CollectionRows {
  issues: StoredIssue;
  bodies: Body;
  comments: Comment;
  sync: SyncState;
}

/** Live issues under a filter per status code. A status the filter leaves out counts 0. */
export type StatusCounts = readonly number[];

export type SortValue = string | number;
/** A row's sort value, and how many rows of the list sort strictly before that value. */
export type Anchor = { readonly value: SortValue; readonly base: number };

/** How a deep window of one list starts at a sort value without reading the rows above it. */
export interface Anchoring {
  /** The anchor of row `n`, or undefined if the list is shorter. */
  locate(n: number): Promise<Anchor | undefined>;
  /** Emits how many rows sort strictly before `value`, then again after changes. */
  watchBase(value: SortValue, emit: (base: number) => void): Unsubscribe;
}

/** How a backend serves each concern, one line each, for the bench report to print next to its numbers. */
export type BackendPath = {
  readonly name: "kv" | "indexeddb" | "sqlite";
  readonly loads: string;
  readonly writes: string;
  readonly counts: string;
  readonly deep: string;
  readonly pressure: string;
  readonly tabs: string;
};

/**
 * Where the model keeps its replica. Merges, the outbox, clocks, query shapes, windows and sync are the model's and
 * run unchanged on every backend.
 *
 * - Only `transact` writes rows. The model never calls insert, update or delete on a collection.
 * - `transact` is atomic per row and serialized within this tab. A backend may commit one call in several
 *   transactions, which is safe because every merge the model passes is per row and idempotent.
 * - A row written with fewer keys loses the missing ones, so a cleared `dirty` and `pending` go away.
 * - Once `transact` resolves, a live query that keeps one of its rows shows the new row.
 */
export interface Backend {
  readonly path: BackendPath;
  /** The store's TanStack collection. The model reads it through live queries only. */
  collection<S extends StoreName>(store: S): Collection<CollectionRows[S], string>;
  /** The stored rows of `ids`, in order, undefined where absent, without loading them into the collection where the backend can avoid it. */
  read<S extends StoreName>(store: S, ids: readonly string[]): Promise<ReadonlyArray<StoreRows[S] | undefined>>;
  /**
   * Writes, for each item, `merge` of its stored row (undefined when absent) and the item: a row to store, `null` to
   * delete, `undefined` to leave the row as it is. `merge` is pure and may run more than once. The backend derives an
   * issue's sort keys from the row `merge` returns.
   */
  transact<S extends StoreName, T extends { readonly id: string }>(
    store: S,
    items: readonly T[],
    merge: (local: StoreRows[S] | undefined, item: T) => StoreRows[S] | null | undefined,
  ): Promise<void>;
  /** Drops every row of a stream. */
  clear(stream: Stream): Promise<void>;
  /** Emits the status counts of the live issues under `filter` once counted, then again after changes. */
  watchCounts(filter: IssueFilter, emit: (counts: StatusCounts) => void): Unsubscribe;
  /** Emits how many live issues are under `filter` once counted, then again after changes. */
  watchTotal(filter: IssueFilter, emit: (total: number) => void): Unsubscribe;
  /** Undefined for a list whose deep windows this backend cannot anchor. Absent: every deep window is one query from the top. */
  anchor?(filter: IssueFilter): Anchoring | undefined;
  /** Calls `ask` when storage wants space and enough threads are cached to be worth clearing. Absent: never. */
  onPressure?(ask: () => Promise<void>): Unsubscribe;
  /** Releases the collections. A database the caller opened and passed in stays open. */
  close(): Promise<void>;
}
