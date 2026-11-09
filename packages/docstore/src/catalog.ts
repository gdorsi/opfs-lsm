/**
 * The catalog: the one stored copy of the schema, under CATALOG_KEY. Every
 * writer in every tab derives entries from it, not from its own code, so a
 * tab on an older app version maintains indexes it never declared.
 */
import type { CollectionId, IndexId, ScanTarget } from "./keys.js";

/** The normalised definition. Two specs are the same index iff their canonical JSON is equal. */
export type IndexSpec =
  | {
      readonly kind: "sorted";
      readonly on: readonly string[];
      readonly unique: boolean;
      /** The first path holds an array: one entry per distinct element. */
      readonly multi: boolean;
    }
  | {
      readonly kind: "text";
      readonly on: readonly string[];
      readonly text: string;
    };

/**
 * building: written by every writer, read by nobody, filled by backfill.
 * ready: written and read.
 * failed: the backfill met data the index cannot hold. Not written, not
 *   read, its prefix is in `dropped`. The next version bump rebuilds it.
 */
export type IndexState =
  | { readonly kind: "building" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly reason: "unique" | "value"; readonly ids: readonly string[] };

/** A dot path, split. */
export type Path = readonly string[];

/** An index's spec with its paths split once per catalog. */
export type CompiledSpec =
  | { readonly kind: "sorted"; readonly on: readonly Path[]; readonly unique: boolean; readonly multi: boolean }
  | { readonly kind: "text"; readonly on: readonly Path[]; readonly text: Path };

/** One maintained index, ready to derive entries and to scan. */
export type IndexPlan = {
  readonly name: string;
  readonly id: IndexId;
  readonly state: IndexState;
  readonly spec: CompiledSpec;
  readonly target: Extract<ScanTarget, { readonly rowPrefix: Uint8Array }>;
};

export type BoundCollection = {
  readonly name: string;
  readonly id: CollectionId;
  /** Every building or ready index in the catalog, declared by this handle or not. Writes derive entries for exactly these. */
  readonly maintained: readonly IndexPlan[];
};
