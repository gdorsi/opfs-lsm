/** The home page's benchmark cards, as the page's frontmatter writes them. Every value is copied from docs/benchmarks.md. */
export type Row = { measure: string; ours: string; theirs: string; ratio: string };
export type Group = {
  title: string;
  versus: string;
  /** opfs-lsm's store and the other one, for the sentence a screen reader reads per row. */
  stores: [string, string];
  setup?: string;
  note?: string;
  rows: Row[];
};
export type Chart = { title: string; theirs: string; groups: Group[] };

// The scale: how many times faster opfs-lsm is, on a log axis from 0.1× to 100×.
const LO = -1;
const HI = 2;
/** Where a ratio sits on the scale, in percent of its width. */
export const xOf = (ratio: number) => ((Math.log10(Math.min(Math.max(ratio, 0.1), 100)) - LO) / (HI - LO)) * 100;
/** Where the 1× line sits. */
export const LINE = xOf(1);
export const ticks = [0.1, 1, 10, 100].map((r) => ({ label: `${r}×`, x: xOf(r) }));

/** A narrow card's strip of dots: the middle lane first, then one up, one down, and so on, in px. */
const LANES = [0, -6, 6, -12, 12];
/** Dots closer than this, in percent of the scale, would touch. */
const NEAR = 4;

/** For each ratio's place on the scale, the lane its dot takes so it doesn't hide another, in the order given. */
export function lanes(xs: number[]): number[] {
  const last: (number | undefined)[] = LANES.map(() => undefined);
  const out = xs.map(() => 0);
  for (const i of xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!)) {
    const lane = Math.max(
      0,
      last.findIndex((at) => at === undefined || xs[i]! - at >= NEAR),
    );
    last[lane] = xs[i];
    out[i] = LANES[lane]!;
  }
  return out;
}

/** "432k ops/s" against "30.2k ops/s" reads "432k vs 30.2k ops/s": the unit once when both share it. */
export function pairText(ours: string, theirs: string) {
  const unit = (s: string) => s.replace(/^[\d.,]+[kM]?\s*/, "");
  const head = (s: string) => s.slice(0, s.length - unit(s).length).trim();
  return unit(ours) === unit(theirs) ? `${head(ours)} vs ${theirs}` : `${ours} vs ${theirs}`;
}
