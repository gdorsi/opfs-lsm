import type { Collection } from "@tanstack/db";
import type { Backend, CollectionRows, StoreName } from "./backend.ts";
import { commands, type Commands } from "./commands.ts";
import { openSync, type Sync } from "./sync.ts";
import type { Transport } from "./transport.ts";

/**
 * LinearLite without React or the browser: the app and Node tests drive the same model. Rows are read with live
 * queries over `collections`, built by `query.ts`.
 */
export interface Linearlite {
  readonly collections: { readonly [S in StoreName]: Collection<CollectionRows[S], string> };
  /** What the backend counts from its indexes without reading rows: the list total, the board counts, deep windows. */
  readonly index: Pick<Backend, "watchTotal" | "watchCounts" | "anchor">;
  readonly commands: Commands;
  readonly sync: Sync;
}

export type OpenOptions = {
  readonly backend: Backend;
  readonly transport: Transport;
};

export function openLinearlite({ backend, transport }: OpenOptions): Linearlite {
  return {
    collections: {
      issues: backend.collection("issues"),
      bodies: backend.collection("bodies"),
      comments: backend.collection("comments"),
      sync: backend.collection("sync"),
    },
    index: {
      watchTotal: (filter, emit) => backend.watchTotal(filter, emit),
      watchCounts: (filter, emit) => backend.watchCounts(filter, emit),
      anchor: (filter) => backend.anchor(filter),
    },
    commands: commands(backend, transport.user),
    sync: openSync(backend, transport),
  };
}
