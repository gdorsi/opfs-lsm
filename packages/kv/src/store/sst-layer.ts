import type { CheckedOp } from "../check.js";
import { KeyOverlay, type OverlayHit } from "./overlay.js";
import { SstReader, type SstEntry } from "./sst.js";

/**
 * Newest-first SST runs with Bloom/block-aware point gets.
 * Range scans materialize a KeyOverlay once.
 */
export class SstLayer {
  private rangeOverlay: KeyOverlay | undefined;

  constructor(private readonly readers: readonly SstReader[]) {}

  static fromBlobs(blobsNewestFirst: readonly Uint8Array[]): SstLayer {
    return new SstLayer(blobsNewestFirst.map((b) => new SstReader(b)));
  }

  get(key: Uint8Array): OverlayHit {
    for (const reader of this.readers) {
      if (!reader.mightContain(key)) continue;
      const e = reader.get(key);
      if (!e) continue;
      if (e.kind === "del") return { status: "tomb" };
      return { status: "value", value: e.value };
    }
    return { status: "miss" };
  }

  /** Materialize merged overlay (for range / view clone). */
  asOverlay(): KeyOverlay {
    if (this.rangeOverlay) return this.rangeOverlay;
    const overlay = new KeyOverlay();
    // Oldest first so newer runs win when applying.
    for (let i = this.readers.length - 1; i >= 0; i--) {
      overlay.applyOps(entriesToOps(this.readers[i]!.entries()));
    }
    this.rangeOverlay = overlay;
    return overlay;
  }

  entriesSorted(): ReturnType<KeyOverlay["entriesSorted"]> {
    return this.asOverlay().entriesSorted();
  }
}

function entriesToOps(entries: readonly SstEntry[]): CheckedOp[] {
  return entries.map((e) =>
    e.kind === "put"
      ? { type: "put" as const, key: e.key as never, value: e.value as never }
      : { type: "del" as const, key: e.key as never },
  );
}
