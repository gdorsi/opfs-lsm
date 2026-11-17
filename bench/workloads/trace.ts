/**
 * The LaTeX editing trace both CRDT families replay, as
 * `[pos, deleteCount, ...insert]`. Fetched once per page, in an untimed
 * phase, from the file the driver downloaded (driver/data.ts). Both
 * families write its head unpaced, then type its tail at one key per frame.
 */
import type { Family, Phase, SizeName } from "../core/types.ts";
import { yieldTask } from "../page/main-thread.ts";

export type Edit = [pos: number, del: number, ...insert: string[]];

let cached: Edit[] | undefined;

export function trace(): Edit[] {
  if (!cached) throw new Error("trace not loaded: put fetchTracePhase() first");
  return cached;
}

/** Edits per size: tiny for CI, small a tenth, large the whole trace (about 260k). */
function traceEdits(size: SizeName): number {
  return { tiny: 2_000, small: 26_000, large: Infinity }[size];
}

export function fetchTracePhase<F extends Family>(): Phase<F> {
  return {
    name: "fetch-trace",
    page: "same",
    timed: false,
    async run(ctx) {
      cached ??= (await (await fetch("/data/edits.json")).json()) as Edit[];
      ctx.carry.edits = Math.min(cached.length, traceEdits(ctx.size));
    },
  };
}

/** FNV-1a of a string: compare documents across pages without carrying them. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

/** One keystroke per 60 Hz frame in the paced `type` phase: fast typing, and one storage write per frame at most. */
export const KEY_MS = 1000 / 60;

/** How many of the trace's last keystrokes the `type` phase replays at KEY_MS each; `persist` writes the rest unpaced. */
export function typedKeys(size: SizeName, edits: number): number {
  return Math.min({ tiny: 100, small: 300, large: 300 }[size], Math.floor(edits / 2));
}

/** Waits until `deadline` (performance.now). A task is yielded either way, so the page can paint between keys. */
export async function paceTo(deadline: number): Promise<void> {
  const wait = deadline - performance.now();
  if (wait > 2) await new Promise<void>((resolve) => setTimeout(resolve, wait - 1));
  else await yieldTask();
}
