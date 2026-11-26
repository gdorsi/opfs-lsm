# Rehearsal: hood

Gold: `hero-demo` and `payout-flow`. Kept from them: named targets, a cursor that does one thing and then rests, connectors that arrive and stay, and a payoff that holds. Framing follows the device-pair pattern: Tab 1 is the hero and bleeds under the cut, Tab 2 is a satellite on Tab 1's wider side, one gutter from the right edge, and the stage is split by a band drawn over both windows. The band's top edge is the cut, and the engine sits under it. On a phone no window covers another (see Layout).

Changed from the gold: the scene is told in chapters and plays with a player (`site/stageshow/chapters.tsx`, and the page's `PlayerBar.vue`, after the demo player on everr.dev). The chapters play in a loop: each plays its beat, then holds its frame for reading, for the time its entry gives; the last goes back to the first by the same transitions. On the stage's bottom edge, pause, the chapters as colored segments with a bar at the play position and the chapter's name in a flag under it, and the time. Under them, the playing chapter's title and detail; from 1376px wide, every chapter's title in a list beside the stage instead, the playing one with its detail. The landing page is always dark, so the scene plays in its dark look. A segment starts its chapter from the frame before it. Pause holds the beat at its next wait; a cursor move or a CSS transition already running finishes. Under reduced motion each chapter is its own still, and the segments only jump.

Chapters (`CHAPTERS.hood[n]` in `site/.vitepress/theme/figures.ts` is the label, title, detail and length, `FRAMES[n]` the whole scene, `BEATS[n]` what plays):
1. Both tabs open the same database. No beat.
2. pick, put (about 5s): Tab 1's status opens LinearLite's menu, the cursor picks Done, and "batch" runs to the write-ahead log: record 43, one row that holds the change's 7 operations ("LL-2A91F · 7 ops"), shows "saved". The log card reads "one row per batch".
3. broadcast (2s): a BroadcastChannel line runs to Tab 2, and its row turns Done.
4. flush, cleared (3.3s): the SharedWorker moves the log into a new file, `l0/41-43.sst`; the log's rows fold away; the SharedWorker's note changes from "a single instance for all the tabs" to "the only file writer".
5. read (2.7s): one of the 9 pages of `l1/c7.0.sst` lights, a copy of it flies to Tab 2's cache meter ("32 KB of 256 MiB"), and Tab 2's placeholder row turns into the real issue. No connector touches the SharedWorker.
6. power loss, then reopen (about 10s of a 14s chapter): the cursor sets a second issue to In Progress, record 44 lands "saved", Tab 2 follows, then the whole stage dims under a "Power lost" mark and holds dark about 2s. The power returns, record 44 turns "lost", the second issue is Todo again in both tabs, the first is still Done, `l0/41-43.sst` is still listed and the cache is empty. This is the payoff; it holds.

Layout:
- Wide (1152 x 576): Tab 1 leads, Tab 2 lies over its right edge, both cut by the band. Each status menu hangs under the status button it opens from, measured from that button.
- Phone (358 x 864, below 720): the compact layout that `main` picked from three phone prototypes, grown by what the steps add. No window covers another. Tab 1 is 380 x 154: the toolbar and the two issues the story changes, cut under the second, and it runs off the right. Tab 2 is 292 wide, sits under Tab 1's right side, keeps its toolbar, shows the same two issues and the older one that step 5 reads, runs off the right and ends under the band. "batch" leaves Tab 1's foot and drops down the free lane left of Tab 2 into the log, for both writes (records 43 and 44). "BroadcastChannel" drops from Tab 1's foot onto Tab 2's top, for both broadcasts. The cache pill hangs under Tab 2 in the band, right-aligned. The engine's type is a step larger than wide. The log keeps three rows, and the "Power lost" mark sits in the log card's empty lower half. The SST card lists `l0/41-43.sst` (after the flush), `l1/c7.0.sst` with its page strip, and a placeholder row that bleeds off the bottom.
- Against the phone design on `main` (358 x 728) the height grows by 136px: 38 for Tab 1's second issue, 76 for two more issues in Tab 2, and 20 for the cache pill under the cut. The foot cuts the SST card at the same depth as `main`'s, about 138px down, which with the new file listed leaves `l1/c7.0.sst` and its page strip whole.

Captured on the home page, at `figure.stepped .illustration-stage`, while the scene was stepped with Next (the beats and frames are the same in the player):
- Widths: 1440 (wide) and 390 (compact, the phone design below 720).
- Looks: light and dark.
- `--gate` on each of the six beats at both widths in both looks (24 runs).
- `--gate --states` on the whole story at both widths in light (Next pressed every 9s).
- Every step as a page screenshot at 390 light and at 1440 dark, taken after the beat settled.

Gate (the verdict line of each of the 24 runs and of the two whole-story runs): `rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)`. No `framing:`, `touching`, `steps in its box` or `hard edge` line stands in any of them.

Captured with the player, at `figure.player .illustration-stage`, with the shipped film: `--gate --states` on the whole loop and into the second pass (62 to 70s) at 1440, twice in dark and once in light, and on the first 16s twice in dark. Every run ends `rehearsal passed`.
- The first loop snapped from the last chapter back to the first: five `appears with no entrance` and `vanishes with no exit` lines (record 44's row, the new file's row, the cache pill, the SharedWorker's note) → the wrap plays the transitions back to the first frame → cleared.
- `steps in its box: div.ss-menu__item "Done"` once, on the second pass through the first menu, in one of the three loop runs. Not seen on the first pass in any run, nor in the light run's second pass.

Film:
- `framing: narrower than tall` (390) → cleared by the compact layout.
- `uneven gutters: div.ss-window` (390, Tab 1 inside the stage) → both tabs run off the right edge → cleared.
- `uneven padding: div.hd-app` (390, Tab 2 without its toolbar) → Tab 2 keeps LinearLite's toolbar, as wide does → cleared.
- `framing: real words "l1/c7.0.sst" cut by the crop` (390) → the compact SST card ends on a placeholder row, which bleeds. Only the top 10px of that row shows, so no bar is cut.
- `steps in its box: div.hd-node` (390) → the log card grew by a row and pushed the SharedWorker down. The compact log card is pinned to three rows → cleared. The SharedWorker's note holds the larger of its two texts (`States`), so the card keeps its size as the note changes.
- `hard edge: span.ss-bar cut by section.hd-card` (390) → the oldest record, a placeholder row, is drawn at 30% so it passes under the card's edge without a hard cut → cleared.
- `framing:` hero lines (corner bleed, satellite gutters, box edges; 11 lines) at 390 with Tab 2's box 240 tall → the film picks the hero as the window with the most shown area and runs its hero checks only when that is over 20% of the stage. Tab 2 (258 x 240 shown, against 62k px² of threshold) went just over, so it was judged as the hero: a 222px gutter above and 100px to its left. Tab 2's box is 230 tall now. It still runs under the band (the cut is at 426, Tab 2 starts at 222), so nothing a viewer sees changed, and the checks do not run. This is a decision, not a fix of those lines. At 390 no window is the hero, and the hero rules do not describe this composition. `main`'s phone design sits under the same threshold, by about 0.5k px².
- `touching: placeholder span.ss-bar ... running into svg / span` under the open status menu → not seen now. The menus hang under the status button, and the phone's Tab 1 has no placeholder rows.
- `steps in its box: span.ss-window__url "LinearLite · Tab 2"` and `div.hd-node` (open on `main`, on 1440 runs) → not seen in any of the 24 runs. Both boxes have `will-change: transform`.
- `manual: same-box content change: ss-connector ... [flush]` (the beat into step 5) → the flush connectors fade out as the read begins; watched in the 100ms frames of the log region, nothing else changes in the same box.
- Every run is `inconclusive` on sampling gaps (largest gap 39 to 58ms on a busy machine).
- `incomplete: Failed to load resource 404` and two failed module imports of `/opfs-lsm/demo` → `favicon.ico` and the hero demo's own app, which dev does not build. They are there without this figure.
- Fixed while filming, before the rebase: the SharedWorker's two note lines started 5px apart; tab 2's window title and the SharedWorker card moved by layout (`will-change: transform`); the cache pill landed on a transform (same); the copy of the page that flies to the cache appeared and vanished without a fade (it buds off the lit page and fades out over the meter as the meter fills); "Power lost" sat on a half pixel (even-sized pill, 16px icon) and landed on a transform (`will-change`).

Review (a fresh reviewer, given the frames, this folder's gold and the page; not this file). It saw the figure before `main`'s phone layout was merged, so it did not see the Layout above:
- Fixed: the pressed look of the status icon showed in Tab 2 as well as Tab 1 (hover mirrored across tabs); the power cut dimmed the windows and the hood but left the stage's ground bright (the ground dims too); Tab 2's dates were not in order (now Nov 12, 11, 9); and two of the Next and Back controls the player has since replaced.
- Not changed, my call: step 6 repeats step 2's menu on purpose, so the second write reads as another change like the first; the log shows "Empty. Records 41 to 43 are in a file." after the flush because that is what the flush does; the reboot first shows the state before the crash and then undoes it piece by piece, so the loss is seen as a transition (the alternative, reverting in the dark and lighting up on the recovered state, shows no loss); the "32 KB of 256 MiB" units are the ones design.md uses.
- Kit behavior, not changed (the kit is read-only here): the status menu fades in over the row text for about 120ms, the cursor's pointing hand swaps to the arrow by a short cross-fade, and avatars take their color from the name.
- Open, with the fix I would make:
  - The payoff has no heavy mark: a small struck-through row and a red "lost" chip. Fix: one list with 41 to 43 in the file above 44, lost, with a visible boundary, and the windows quieter.
  - At 1440 the engine gets the smaller and emptier half of the frame (cards of two to four rows, an empty strip around the SharedWorker). Fix: raise the cut and widen the cards.
  - The cursor stays full white over the dimmed stage for about a second after the power cut.
  - The nine tiles on `l1/c7.0.sst` carry no words; the caption names the 32 KB page.
  - The phone design is 864px, still taller than a phone screen. `main`'s layout does fix the part that hurt: Tab 1 and the engine are no longer 560px apart with Tab 2 between them. The parts each chapter acts on now lie within 540px of each other (chapter 2: Tab 1's first issue to the log's records; chapter 5: Tab 2's older issue to the `l1/c7.0.sst` row). The player and the playing chapter's text sit under the stage, so on a phone they come into view only once the reader has scrolled down to the engine. A shorter design, one tab and the one card each chapter touches moved by a Camera, would still be shorter, but it is a redesign of `main`'s layout, so it is not done.

Assumptions (each drawn the way it reads):
- The flush runs after one write. The engine waits for the write-ahead log to reach `maxWalBytes`.
- The log's rows leave it with the flush that folded them. The engine keeps them until the next flush, as a recovery copy that no read uses (design.md, "Truncation").
- Step 5 shows one get. An app query reads index entries and documents, so it loads several pages.
- Step 6 shows one legal outcome of a power loss. A loss could also take record 43 and any earlier write that no flush had reached, but it takes a write only together with every write after it.
- Each record is one status change, 7 operations: the issue, and for each of its three indexes on status or modified time, the old entry deleted and the new one put (counted from `docstore` with LinearLite's schema). Records 41 and 42 are drawn as status changes too. A new issue is 5 operations; an import, one batch of thousands.
- The cache meter's fill is drawn wider than 32 KB of 256 MiB really is, so it can be seen.
- A reopened tab has an empty cache, so Tab 2's older issue is a placeholder row again until the tab reads it.
- On phones, an open status menu draws past Tab 1's window onto Tab 2. The first covers Tab 2's title bar for about a second. The second, opened from the second issue, also covers Tab 2's toolbar and the left of its first issue. A real menu stays inside its window. Tab 1 can't hold either unless the figure grows by about 150px.
- The tab writes the log itself; the SharedWorker only flushes and compacts. That is why "batch" comes from the band under Tab 1 wide, and from Tab 1's foot on a phone, and never from the SharedWorker.
- A tab's first get from a file also starts loading the file's Bloom filter; step 5 shows only the page.

Filming:
- The player plays by itself, so the shipped `film.mjs` films it as it is (`--gate --states --states-for 70000` for the whole loop). The stepped runs above were filmed while the scene was stepped with Next, which `film.mjs` as shipped cannot press, so the beats were filmed with a copy of it kept outside the repository. The copy adds `--from n` (scroll the figure into view, wait 2s for its script to start, click Next n times in one tick so the stage lands on step n by a snap, wait 2.6s, then empty the box and motion recorders, which run from page load and would otherwise judge that snap as a jump) and `--press-every ms --press-count n` (click Next on a timer once filming starts). The beat into step k, counting steps from 1 as above, is filmed with `--from k-2 --press-every 900 --press-count 1`. The whole-story runs use `--press-every 9000 --press-count 6 --states`.
- Everything else is the shipped film, `--gate`, at the real page URL, selecting `figure.stepped .illustration-stage` (now `figure.player .illustration-stage`).
- Page screenshots were taken with Playwright in headless Chrome: the stage alone, after waiting 9s for each beat to settle, in a 1500px-high viewport at 390 and a 1000px-high one at 1440.

Checked by hand with the player, in Chrome: pause holds the time and the scene, a segment jumps to its chapter and plays on, no horizontal scroll, at 1440 and 390, light and dark; under reduced motion the pause and time are gone and a segment shows its chapter's still.

Not checked since `main`'s phone layout was merged in (checked before, on the branch's own phone design):
- The host's controls with `layout.mjs`.
- Reduced-motion stills of every chapter (the last one was checked).
- A fresh-eye review (`review.md`) of the merged phone layout or of the player.

Not checked:
- Safari, Firefox and a real phone. All filming was headless Chrome on a Mac.
- Widths between 390 and 1152, where the stage scales.
- Live frame rate: the film's clock proves geometry, not smoothness.
- A burst of segment clicks during a beat, and pause and play many times in one beat.
- Screen reader output and focus order of the player; touch on the segments' hover preview.
- The merged page's other sections (hero, notices, benchmarks) beyond the figure's own section.
