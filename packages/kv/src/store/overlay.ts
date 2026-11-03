import { compareBytes, keyToString } from "../bytes.js";
import type { CheckedOp } from "../check.js";
import type { WalRecord } from "../idb/wal.js";

export type OverlayHit =
  | { status: "miss" }
  | { status: "tomb" }
  | { status: "value"; value: Uint8Array };

/** Mutable map of user-key → latest put/del. */
export class KeyOverlay {
  private readonly map = new Map<
    string,
    { key: Uint8Array; kind: "put" | "del"; value?: Uint8Array }
  >();
  private sorted:
    | (
        | { key: Uint8Array; kind: "put"; value: Uint8Array }
        | { key: Uint8Array; kind: "del" }
      )[]
    | undefined;

  applyOps(ops: readonly CheckedOp[]): void {
    if (ops.length === 0) return;
    this.sorted = undefined;
    for (const op of ops) {
      const k = keyToString(op.key);
      if (op.type === "put") {
        this.map.set(k, {
          key: op.key,
          kind: "put",
          value: op.value,
        });
      } else {
        this.map.set(k, { key: op.key, kind: "del" });
      }
    }
  }

  applyRecords(records: readonly WalRecord[]): void {
    for (const r of records) this.applyOps(r.ops);
  }

  get(key: Uint8Array): OverlayHit {
    const e = this.map.get(keyToString(key));
    if (!e) return { status: "miss" };
    if (e.kind === "del") return { status: "tomb" };
    return { status: "value", value: e.value! };
  }

  /** Snapshot entries for fake L0 encode (sorted). Cached until the next mutate. */
  entriesSorted(): (
    | { key: Uint8Array; kind: "put"; value: Uint8Array }
    | { key: Uint8Array; kind: "del" }
  )[] {
    if (this.sorted) return this.sorted;
    const rows = [...this.map.values()];
    rows.sort((a, b) => compareBytes(a.key, b.key));
    this.sorted = rows.map((r) => {
      if (r.kind === "put") {
        return { key: r.key, kind: "put" as const, value: r.value! };
      }
      return { key: r.key, kind: "del" as const };
    });
    return this.sorted;
  }
}

export type ReadableLayer = {
  get(key: Uint8Array): OverlayHit;
};

/**
 * Read path: shared uningested WAL (newer) over SST layer (older).
 * Ack'd IDB rows are visible to every tab before OPFS ingest.
 * SST may be a KeyOverlay or an SstLayer (Bloom + block-aware).
 */
export function resolveGet(
  key: Uint8Array,
  wal: ReadableLayer,
  sst: ReadableLayer,
): Uint8Array | undefined {
  const local = wal.get(key);
  if (local.status === "tomb") return undefined;
  if (local.status === "value") return new Uint8Array(local.value);
  const sealed = sst.get(key);
  if (sealed.status === "tomb") return undefined;
  if (sealed.status === "value") return new Uint8Array(sealed.value);
  return undefined;
}
