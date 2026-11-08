/**
 * The LaTeX editing trace both CRDT families replay, as
 * `[pos, deleteCount, ...insert]`. Fetched once per page, in an untimed
 * phase, from the file the driver downloaded (driver/data.ts).
 */
import type { Family, Phase, SizeName } from "../core/types.ts";

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
