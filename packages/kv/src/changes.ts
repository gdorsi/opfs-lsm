/**
 * One op of a WAL record. The bytes are the memtable's: read them, never
 * write to them. Switch on `type` exhaustively: a `deleteRange` has no `key`.
 */
export type ChangeOp =
  | { readonly type: "put"; readonly key: Uint8Array; readonly value: Uint8Array }
  | { readonly type: "del"; readonly key: Uint8Array }
  /**
   * Every row in [start, endExclusive) last written at or before seq
   * `through` is gone. `through` is resolved: always below the event's seq.
   * A listener that does not know the seq of each row it holds reads the
   * range again.
   */
  | {
      readonly type: "deleteRange";
      readonly start: Uint8Array;
      readonly endExclusive?: Uint8Array;
      readonly through: number;
    };

/**
 * For every seq a handle applies, its listeners get exactly one `append`
 * with that seq, or one `gap` whose `through` covers it, in increasing seq
 * order, whichever path brought the record: this handle's write, another
 * tab's BroadcastChannel message, or a catch-up from the WAL. The event
 * fires once the state that includes the seq is readable, and a write's
 * promise resolves after its record was announced.
 */
export type ChangeEvent =
  | { readonly kind: "append"; readonly seq: number; readonly ops: readonly ChangeOp[] }
  /** The handle's state moved to `through` past records it never announced. Read again. */
  | { readonly kind: "gap"; readonly through: number }
  /** The last event: the handle closed. */
  | { readonly kind: "closed" };

export type ChangeKind = ChangeEvent["kind"];

export type ChangeListener = (event: ChangeEvent) => void;

/** Fan-out for local + cross-tab change notifications. */
export class ChangeBus {
  private readonly listeners = new Set<ChangeListener>();

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("changes() listener threw", err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
