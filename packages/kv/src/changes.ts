/**
 * `local`: a write of this page was acked, and reads here see it.
 * `ingest`: this page installed a new manifest, and reads see every write
 * it holds, from any page. Other pages' writes arrive only this way.
 */
export type ChangeEvent = { readonly kind: "local" } | { readonly kind: "ingest"; readonly generation: number };

export type ChangeKind = ChangeEvent["kind"];

export type ChangeListener = (event: ChangeEvent) => void;

/** Fans one page's change events out to its listeners. */
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
