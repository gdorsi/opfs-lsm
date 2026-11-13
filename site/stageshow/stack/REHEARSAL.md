# Rehearsal: stack

Gold: `story` (related objects and connectors), with `stacked-cards` for the phone. Kept: a few related objects, measured connectors, no cursor. Changed: the objects are a tab, the write-ahead log in IndexedDB and the SST files in OPFS; the phone layout is one sheet with three sections.

Beats: 1 "put" draws from the tab to the log … 2 record 43 lands above 41 and 42, acked … 3 "SharedWorker" draws to the files, `l0/41-43.sst` arrives on top and the log's rows collapse into "41 to 43, truncated" … 4 record 44 starts the log again … 5 "get" draws from the files to the tab (phone: a "read by the tab" label). Plays once, about 9 s.

Captured: wide (620) and 390, light and dark, `--states`, the reduced-motion poster, and the real home page on the dev server at 1440 and 390 in both looks.

Gate: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)

Film:
- `loose stack: "record 44" above "41 to 43"` → the truncated row was drawn faint, so it read as a subtitle; it is a plain row with its own badge. Passed after.
- Earlier lines, fixed: `uneven gutters` for three stacked cards on the phone (one sheet off the bottom), `lands on a transform` on the phone label (a lasting layer).

Review (fresh eye, before the last round of changes):
- It sat beside "One store under your stack" but illustrated "Under the hood" → moved to "Under the hood"; the adapter chips are gone.
- Gray bars where the eye lands → the files list has real names (`l0/…`, `l1/c…`), the log opens with two real records. The log keeps filler rows under them: it is truncated at every flush, so more real rows would be false.
- Phone: one slab, a tooltip for the read, a void at the open → rules between the three sections, the read label drawn as the lines' labels are, and the log opens with rows.
- Connectors draw as a bare line, then head and label → the kit's Connector; stands.
- Plate, shadow and host type: as in bench.

Assumptions: record numbers and file names are examples in the engine's real formats (`l0/<first>-<last>.sst`, `l1/c<generation>.<i>.sst`). The flush truncating the log follows design.md, "Flush".

Unresolved: on the phone the read is a label, not a line back to the tab.

Not checked: a real phone, Safari and Firefox, motion inside the film's sampling gaps, reduced motion on the real page. No second fresh-eye pass ran after the review's fixes.
