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
export const at = (ratio: number) => ((Math.log10(Math.min(Math.max(ratio, 0.1), 100)) - LO) / (HI - LO)) * 100;
export const ONE = at(1);
export const ticks = [0.1, 1, 10, 100].map((r) => ({ label: `${r}×`, x: at(r) }));

/** "432k ops/s" against "30.2k ops/s" reads "432k vs 30.2k ops/s": the unit once when both share it. */
export function values(ours: string, theirs: string) {
  const unit = (s: string) => s.replace(/^[\d.,]+[kM]?\s*/, "");
  const head = (s: string) => s.slice(0, s.length - unit(s).length).trim();
  return unit(ours) === unit(theirs) ? `${head(ours)} vs ${theirs}` : `${ours} vs ${theirs}`;
}
