export type ChangeKind = "append" | "ingest";

export type ChangeEvent = {
  readonly kind: ChangeKind;
  readonly writerId: string;
  /** WAL seq of the append, when kind === "append". */
  readonly seq?: number;
};

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
