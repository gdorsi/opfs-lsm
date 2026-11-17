# Rehearsal: hood

Gold: `hero-demo` and `payout-flow`. Kept from them: five beats with named targets, a cursor that does one thing and then rests, connectors that arrive and stay, and a payoff that holds. Framing follows the device-pair pattern: Tab 1 is the hero and bleeds under the cut. Tab 2 is a satellite on Tab 1's wider side, one gutter from the right edge. Changed: the stage is split by a band drawn over both windows. The band's top edge is the cut, and the engine sits under it.

Beats:
1. pick (0.7s): Tab 1's status opens LinearLite's menu, and the cursor picks Done.
2. put (2.8s): record 43 is written to the write-ahead log and shows "saved".
3. broadcast (4.8s): a BroadcastChannel line runs to Tab 2, and its row turns Done.
4. flush (7.5s): the SharedWorker moves the log into a new file, `l0/41-43.sst`.
5. cleared (9.9s): the log's rows fold away and the card reads "Empty. Records 41 to 43 are in a file." The log card keeps its height, so the SharedWorker and the files never move. The result holds.

`play="once"`, about 13s. The poster is the payoff.

Captured on the home page:
- Widths: 1440 (wide, 1152 x 576 stage) and 390 (compact, 358 x 736, full below 720).
- Looks: light and dark.
- `--gate` at both widths in both looks; `--states` at both widths.
- `--reduced` posters at 1440 light and 390 dark.
- Stills at `flush` and after `cleared`, and the whole section at 1440 and 390.

Gate: `rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)` at 1440 and 390, light and dark.

Film:
- `framing: narrower than tall` (390) → cleared by the compact layout below.
- Compact relayout, picked from three phone prototypes because the 880px compact layout was hard to read. Nothing overlaps: Tab 1 is 380 x 116, cut just under the issue, and runs off the right. Tab 2 is 292 wide, sits under Tab 1's right side, runs off the right and ends under the band. "put" drops down the free lane left of Tab 2. The engine's type is a step larger than wide.
- `uneven gutters: div.ss-window` (390, Tab 1 inside the stage) → both tabs run off the right edge → cleared.
- `uneven padding: div.hd-app` (390, Tab 2 without its toolbar) → Tab 2 keeps LinearLite's toolbar, as wide does → cleared.
- `framing: real words "l1/c7.0.sst" cut by the crop` (390, once the new file pushes the list down) → compact lists one real file and a placeholder row, which bleeds → cleared.
- `steps in its box: div.hd-node` (390) → the log card grew by a row and pushed the SharedWorker down. The compact log card is pinned to three rows → cleared.
- `hard edge: span.ss-bar cut by section.hd-card` (390) → the oldest record, a placeholder row, is drawn at 30% so it passes under the card's edge without a hard cut → cleared.
- `touching: placeholder span.ss-bar running into svg/span` (1.5 to 2.0s) → stands. These are Tab 1's filler bars under the open status menu. The menu is opaque, so nothing of them shows.
- `steps in its box: span.ss-window__url "LinearLite · Tab 2"` and `div.hd-node` (on the home page: every 1440 run in one checkout, only 390 dark in another; never on the prototype page) → open. Where it shows follows the page, not the scene. A frame-by-frame trace in the film's own setup (viewport as tall as the page, scrolled to the top, 1x and 2x) shows neither box moving, against the stage or the viewport, and the cleared beat does not touch either.
- `incomplete: Failed to load resource 404` → `favicon.ico`, from the page.

Assumptions:
- The flush right after one write is a simplification. The real trigger is the log reaching `maxWalBytes`.
- The engine deletes the rows a flush folded at the next flush, keeping them as a recovery copy that no read uses (design.md, "Truncation"). The figure lets them go with the flush that folded them.
- The tab writes the log itself; the SharedWorker only flushes and compacts. That is why "put" comes from the band under Tab 1, not from the SharedWorker.

Not checked:
- Every beat zoomed at 40ms. Only the menu was filmed close up.
- Widths between 390 and 1152, where the stage scales.
- Safari and Firefox, and a real phone.
- A fresh-eye review.
