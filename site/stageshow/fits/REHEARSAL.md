# Rehearsal: fits

Gold: this folder's own earlier still, four use cases as four columns. It came from `story` (related objects joined by measured connectors) set in the frame of the page's `adapters` card. Kept: one column of it, as it was: a quiet outlined "Server" on top, a dashed gray "sync" line, the library as a white node, an accent arrow labeled with what the library stores, and the opfs-lsm node carrying its package, the one accent in the figure. Changed: the figure draws one case, the one picked in the home page's use cases (`UseCases.vue`), so it is 300 wide, the width of that card's left column, on the page's soft gray. OPFS is no longer a floor under the columns: it is named inside the opfs-lsm node, under a rule, as the earlier narrow design already did. One column has no room for a floor, and opfs-lsm becomes the column's foot.

Beats: none. A still. Picking another case, or the other adapter of a case with two, swaps the library, the stored words and the package in place with the kit's `Swap`. Every case names one library and one package, so no box changes size.

Captured: `--still --gate` on the real home page on the dev server at :5320, selecting `.uc-panel .illustration-stage`, at 1440 and 390, light and dark.

Gate: rehearsal passed at all four (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)

Film:
- `uneven gutters: div.fi-lsm … 111px from the bottom` → the stage was tall enough for two package lines, so a one-package case left a band under the disk. The figure now draws only the adapter on show, and the stage fits the column with one 20px gutter. Still failed.
- `uneven gutters: div.fi-lsm … 94px from the bottom` → OPFS was its own box under opfs-lsm, unfilled, so opfs-lsm read as a card stranded above the stage's foot. OPFS moved inside the opfs-lsm node. Passed after.
- Seen on the page, not in the film: with two packages the opfs-lsm node grew while `Swap` eased its height, and the measured line down to OPFS stayed where the node used to end (the kit's `Swap` ends its transition before `transitionend`, so the stage never measured again). Went away with one package per case and no line down.

Review: no fresh-eye subagent ran. Compared by eye with the four-column still: the eye lands on the opfs-lsm node, the accent, which is the payoff; the server is the quietest object; every word is real.

Assumptions: the case's words come from the `fits:` frontmatter of site/index.md, through `UseCases.vue`. "Server", "sync", "opfs-lsm", "OPFS" and "the browser's file storage for your site" are the figure's own.

Unresolved: none known.

Not checked: a real phone, Safari and Firefox.
