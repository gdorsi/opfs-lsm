# Rehearsal: bundle

Gold: `overlap`. Kept: a card in front of a window, straddling the window's sidebar line, the window off the bottom. Changed: the window is a code editor with a mark on the line being run, and the card is a ledger of what the page has downloaded.

Beats: 1 the mark rests on the import, the card shows 17.1 kB and two placeholder rows … 2 the click handler's line … 3 the call to openDb … 4 the two rows resolve into the SharedWorker chunk and the wasm engine … 5 "+27.8 kB on the first openDb" appears under the figure. Plays once, about 7 s. The phone layout has no handler line and goes from the import to the call.

Captured: wide (620) and 390, light and dark, `--states`, the reduced-motion poster, and the real home page on the dev server at 1440 and 390 in both looks.

Gate: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)

Film:
- `uneven gutters: section.bd-card` (real page, 1440, once) → the card sat 32px from the left and from the bottom; it is now centered on the stage's height. Passed after.
- `steps in its box: div.bd-slot` (real page, 390, once) → a placeholder row cross-fading into its words in one grid cell; nothing moves. Stands.
- Earlier lines, fixed: a clipped code line (shorter code), an empty pane on the phone (the card covers the window's lower third), a truncated row title.

Review (fresh eye, before the last round of changes):
- The resting frame showed 45.0 kB beside the heading "17.1 kB to import", and the total did not equal its rows → the large figure stays 17.1 kB; the lazy part is the README's own 27.8 kB, added under it. No total is computed.
- Empty lower third of the editor → seven more real lines (the README's put), cut by the crop.
- The call had no cause → the mark visits the click handler first.
- Phone: card and window shared a left edge → the card is inset 16px and overlaps more.
- Plate, shadow and host type: as in bench.

Assumptions: sizes come from the page's frontmatter, checked against README.md by the build.

Not checked: a real phone, Safari and Firefox, motion inside the film's sampling gaps, reduced motion on the real page. No second fresh-eye pass ran after the review's fixes.
