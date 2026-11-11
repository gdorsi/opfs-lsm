import { expect, vi } from "vitest";
import type { CollectionChange } from "../src/index.js";
import type { Doc, Docs } from "./docs.js";

/**
 * What a reader of the contract keeps: subscribe, read a snapshot, apply the
 * events after the snapshot's seq, and read again on a gap.
 */
export function mirror(c: Docs) {
  const docs = new Map<string, Doc>();
  let from = 0;
  let held: CollectionChange<Doc>[] | undefined;

  const load = () => {
    held = [];
    void c
      .view(async (snap) => {
        const page = await snap.query({});
        docs.clear();
        for (const d of page.docs) docs.set(d.id, d);
        from = snap.seq;
      })
      .then(() => {
        const replay = held!;
        held = undefined;
        for (const e of replay) apply(e);
      })
      .catch(() => undefined);
  };

  const apply = (e: CollectionChange<Doc>) => {
    if (held) held.push(e);
    else if (e.kind === "gap") load();
    else if (e.kind === "append" && e.seq > from) {
      for (const ch of e.changes) {
        if (ch.deleted) docs.delete(ch.id);
        else docs.set(ch.id, ch.doc!);
      }
    }
  };

  const stop = c.changes(apply);
  load();
  return {
    docs,
    stop,
    /** Resolves once the mirror holds `want`. */
    reaches: (want: ReadonlyMap<string, Doc>) =>
      vi.waitFor(
        () => {
          expect(held).toBeUndefined();
          expect(Object.fromEntries(docs)).toEqual(Object.fromEntries(want));
        },
        { timeout: 3_000, interval: 2 },
      ),
  };
}
