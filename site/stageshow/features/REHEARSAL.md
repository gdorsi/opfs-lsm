# Rehearsal: features

Gold: `ruled-bento` (tiles on one ground, 1px rules between them, a lead tile two columns wide and two rows tall, pictures that run off a tile's edge). Kept: the ruled grid, the lead tile, the bleeds, a chip collection, a one-glyph statement tile. Changed: each title sits at the tile's foot at 16px, the brief's order, with no sentence after it. The lead tile shows two chromeless tab cards, not a window. No numbers anywhere, so the statement tile is its title and a bolt.

Beats: tiles start 100ms apart in reading order, each doing its own thing once. 1 Live: "Offline mode" is checked in Tab 1, the arrow draws, and it shows checked in Tab 2 … Lightweight: the bolt strikes … Adapters: the four chips open one after another … API: the batch writes in … Quota: the meter fills up and the badge reads "Storage full" … Crash: "Writing" turns to "Crashed" with one write in flight … 2 Quota: "Oldest evicted", the meter falls back … Crash: "Reopened" with the four acked writes, the in-flight one gone … Live: "Dark mode" is checked in Tab 2 and shows in Tab 1, the arrow pointing back. Plays once, about 4.2s. The poster is the end, with every result on screen.

Captured: wide (600, on the real home page at 1280) and compact (358, at 390), light and dark, 24 frames every 250ms at each. `--states` at 1280. The reduced-motion poster at 1280 and 390, and at 1280 dark. `.VPHero` stills at 1280, 1100 and 390, light and dark, at the end state.

Gate: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand), at 1280 and 390, light and dark.

Film:
- `near-tangent: div.ss-card and section.ft-tile are only 1px apart` (1280 only) → stands. It is the API tile's code card, which runs off the tile's right edge on purpose and is clipped there, one rule away from the next tile.
- `clipped: near aligned: … "Tab 1" / "TanStack DB" / "db.batch((tx) => {" and div.ft-title … 11 to 12px apart` → stands. Not a gate line. The offset is the card's or chip's own padding; the cards and chips share the title's left edge.
- `uneven gutters` on the two tab cards → fixed. The cards run past the lead picture's foot and fade out over their filler rows, so they bleed instead of floating.
- `loose stack` when the compact quota badge sat under the meter → fixed. The compact grid pairs Lightweight with Quota and Adapters with API, and puts Crash as a band across the foot.
- `lands on a transform` on the "Reopened" lane → fixed with `will-change: transform`.
- Seen in frames, not by the gate: the meter went through a muddy purple-gray while it crossfaded from accent to warning → the meter keeps the accent; the badge carries the state.
- Seen in frames: the code card ran into its title → four lines at 17px, the line-number gutter hidden, rows of 120, 120 and 174.

Review: no separate fresh-eye reviewer ran. Judged against `ruled-bento` and `bento`:
- The eye lands on the lead tile's two checked rows and the arrows between them, then on the large statement title. That order matches the feature order.
- The one difference from the gold: titles at the foot, with no line of copy after them.
- The adapter chips leave about 26px of ground above their title at 1280. It reads as the tile's inset, not a void.

One Stage, against bento rule 12: the whole grid is a single Stage, not one per tile. The hero column shows it at its design size (600 wide, 358 on a phone), so no title is ever drawn below its design size, which is what the rule protects.

Assumptions: the issue titles and assignees are examples. The four adapters are the packages this repo ships, drawn as names, never logos. The crash tile claims only that acked writes survive, never that nothing is lost.

Unresolved:

Not checked: a real phone, Safari and Firefox, motion inside the film's sampling gaps (every run was inconclusive on coverage, largest gap 34 to 58ms), reduced motion toggled during playback, the Replay button. No second fresh eye. The dev server's file watcher missed edits made in this worktree, so every filmed run followed a restart of the server on port 5321.
