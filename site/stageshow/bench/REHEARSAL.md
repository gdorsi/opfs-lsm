# Rehearsal: bench

Gold: `payout-flow`. Kept: one card pinned top and off the bottom, slow arrivals in turn, no cursor, a payoff that holds. Changed: the card is a benchmark run, with two meters and two rolling figures per workload and a status badge that becomes the result.

Beats: 1 first workload runs, bars grow, figures roll … 2 its badge becomes "24× faster" … 3 the TanStack DB workload … 4 the single put, where kv's bar is the shorter one and the badge reads "0.8× as fast". Plays once, about 9 s, then rests on the poster (all three results).

Captured: wide (620) and 390, light and dark, `--states`, the reduced-motion poster, and the real home page on the dev server at 1440 and 390 in both looks.

Gate: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)

Film:
- `appears with no entrance: span.ss-count` (real page, 1440) → the figures sit in a cell that fades in over 0.8 s; the kit's digit strip is whole inside it from the first frame. Stands.
- Earlier lines, fixed: a lopsided spinner badge (plain "Running" badge), a unit touching its figure (6px gap), a blue IndexedDB bar (gray tone), a gap inside "341k" (system type, whose figures are tabular).

Review (fresh eye, before the last round of changes):
- Tinted plate on a white page, black plate on the dark page → the ground is the page's own soft gray, cards step up from it in dark.
- Phone: card shadow fills the 16px gutters → a shorter, lower shadow in the compact layout.
- The losing row was unlabelled and the phone dropped the words → "0.8× as fast", words at both widths.
- The figure landed before its bar → bar and count both run 0.9 s.
- Host page styles leaked in (a code chip on the command, proportional figures) → the command is a plain span, the type is the system's.
- "Flatter than the gold: nothing moves but bars" → stands. The card is a results table; a second object would be decoration.

Assumptions: the page passes the rows from its frontmatter, which the build checks against README.md. A row with no ratio in the README shows "faster" alone.

Not checked: a real phone, Safari and Firefox, motion inside the film's sampling gaps (coverage read "inconclusive"), reduced motion on the real page (playground only). No second fresh-eye pass ran after the review's fixes.
