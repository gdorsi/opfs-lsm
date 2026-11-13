# Rehearsal: adapters

Gold: `payout-flow`. Kept: one card pinned top and off the bottom, slow arrivals in turn, no cursor, a payoff that holds. Changed: the card spans the page and has a column per framework; each column holds two workloads, with two meters, two rolling figures and a status badge that becomes the result.

Beats: 1 TanStack DB in eager mode runs: bars grow, figures roll, the badges become "1.6× faster" on the cold load and "6.7× faster" on the bulk insert … 2 TanStack DB in on-demand mode, against its SQLite adapter: "2.1× faster" on 10 rows by id, "1.5× faster" on a warm query … 3 Yjs … 4 Automerge … 5 fate. Plays once, about 11 s, then rests on the poster (all ten results).

Layout: five frameworks don't fit five columns at 1152 (values ran into the next column), so the two TanStack DB columns share the top row and the other three the row under it. The rule above each workload is a line of its own, not the group's border: as a bordered box, a workload in the wide top row read as a panel with uneven gutters (`uneven gutters`, fixed). On the phone the columns stack as before, and a framework's name stays on one line.

Captured: full width (1152, in a 1280 viewport) and 390, `--states` at both, the reduced-motion poster at both, dark stills at both, and the real home page on the dev server at 1440 and 390.

Gate: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)

Film:
- `uneven gutters: div.ad-group`, `div.ad-col` (390) → the rules between frameworks and workloads were borders on the blocks, so each block read as a box floating in the card. They are lines of their own now. Passed after.
- `appears with no entrance: span.ss-count` → the figures sit in a cell that fades in over 0.8 s; the kit's digit strip is whole inside it from the first frame. Stands.

Review: no fresh-eye pass ran on this scene. It reuses the benchmark card that the earlier review covered: the ground is the page's own gray, the slower row says so in words, bar and count land together.

Assumptions: the page passes the frameworks from its frontmatter, which the build checks against README.md. A ratio within a twentieth of 1 shows "about equal". The phone design shows all eight workloads, so it is tall (962px).

Unresolved: between 720 and 1152 px of column width the wide design is scaled down, to about 0.63 at the narrowest, where its 12px type reads small.

Not checked: a real phone, a tablet width, Safari and Firefox, motion inside the film's sampling gaps (coverage read "inconclusive"), reduced motion on the real page.
