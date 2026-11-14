/**
 * What the pages workloads share: the typing script, the pace they type at,
 * and the recorders that tell storage work from Automerge's own.
 */
import type { PersistenceStorage } from "@nkzw/fate/persistence";
import type { BodiesOptions } from "../../examples/pages-fate-automerge/src/model/bodies.ts";
import type { PagesStorage, TextEdit } from "../../examples/pages-fate-automerge/src/model/types.ts";
import type { Edit } from "../workloads/trace.ts";
import type { PhaseContext } from "../core/types.ts";

/**
 * Time is compressed 20 times. A typist at 8 keys a second against the Repo's
 * 100 ms save throttle gives 1 or 2 keys per save. 6 ms keys against a 5 ms
 * throttle give the same ratio, so storage operations per key stay what a
 * real session makes while a 1,000-key phase lasts seconds, not minutes.
 */
export const KEY_MS = 6;
export const SAVE_THROTTLE_MS = 5;

/** `open` of an unknown page must not wait for a peer to turn up. */
export const PEER_WAIT_MS = 50;

/** Every 40th keystroke is typed in bold, as someone toggling the mark would. */
const BOLD_EVERY = 40;

/**
 * Each trace edit becomes one keystroke. Positions start at `base`, just past
 * the pasted body, and a "\n" becomes a block split, which counts as one
 * character like the newline did, so every position carries over.
 */
export function typingScript(trace: readonly Edit[], keys: number, base: number): TextEdit[][] {
  return trace.slice(0, keys).map(([pos, del, ...ins], key) => {
    const at = base + pos;
    const edits: TextEdit[] = [];
    if (del > 0) edits.push({ type: "delete", at, count: del });
    const marks = key % BOLD_EVERY === BOLD_EVERY - 1 ? { bold: true as const } : {};
    let cursor = at;
    ins
      .join("")
      .split("\n")
      .forEach((line, i) => {
        if (i > 0) edits.push({ type: "split", at: cursor++, block: { type: "paragraph" } });
        if (line.length > 0) {
          edits.push({ type: "insert", at: cursor, text: line, marks });
          cursor += line.length;
        }
      });
    return edits;
  });
}

type DocMetrics = Parameters<NonNullable<BodiesOptions["onDocMetrics"]>>[0];

export type Recorder = {
  readonly storage: PagesStorage;
  readonly onDocMetrics: (metrics: DocMetrics) => void;
  /** Adds what happened since the last call to the phase's counters, and returns the storage calls it made. */
  report(ctx: PhaseContext<"pages">): number;
};

/** Counts the calls each layer receives and the bytes the Repo saves, and sums Automerge's own CPU from its doc metrics. */
export function recorder(inner: PagesStorage): Recorder {
  const total: Record<string, number> = {};
  const seen: Record<string, number> = {};
  const add = (name: string, n = 1) => {
    total[name] = (total[name] ?? 0) + n;
  };
  const bodies: PagesStorage["bodies"] = {
    load: (key) => (add("body loads"), inner.bodies.load(key)),
    loadRange: (prefix) => (add("body loads"), inner.bodies.loadRange(prefix)),
    save: (key, data) => (add("body saves"), add("saved bytes", data.byteLength), inner.bodies.save(key, data)),
    remove: (key) => (add("body removes"), inner.bodies.remove(key)),
    removeRange: (prefix) => (add("body removes"), inner.bodies.removeRange(prefix)),
  };
  const fate: PersistenceStorage = {
    read: (key) => (add("fate calls"), inner.fate.read(key)),
    scan: (...args) => (add("fate calls"), inner.fate.scan(...args)),
    writeBatch: (writes) => (add("fate calls"), inner.fate.writeBatch(writes)),
    exclusive: (key, run) => (add("fate calls"), inner.fate.exclusive(key, run)),
  };
  const DOC_MS = { "doc-loaded": "am load ms", "doc-saved": "am save ms", "doc-compacted": "am snapshot ms" } as const;
  return {
    storage: { fate, bodies },
    onDocMetrics(metrics) {
      const name = DOC_MS[metrics.type as keyof typeof DOC_MS];
      if (name && typeof metrics.durationMillis === "number") add(name, metrics.durationMillis);
      if (metrics.type === "doc-compacted") add("am snapshots");
    },
    report(ctx) {
      for (const [name, value] of Object.entries(total)) {
        ctx.count(name, value - (seen[name] ?? 0));
        if (name === "saved bytes") ctx.bytes(value - (seen[name] ?? 0));
        seen[name] = value;
      }
      const ops = (total["body loads"] ?? 0) + (total["body saves"] ?? 0) + (total["body removes"] ?? 0) + (total["fate calls"] ?? 0);
      const made = ops - (seen["storage ops"] ?? 0);
      seen["storage ops"] = ops;
      ctx.count("storage ops", made);
      return made;
    },
  };
}
