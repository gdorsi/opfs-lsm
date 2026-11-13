# Rehearsal: reopen

Gold: `loading` (a skeleton at the content's own geometry, rows resolving top to bottom 70ms apart, each whole, real chrome throughout), on the composition of the previous hero, which came from `subscriptions` (a card straddling a browser window, its right edge on the window's sidebar line, no cursor). Kept from `loading`: each skeleton bar shares one grid cell with what replaces it, the faint slow shimmer, the 70ms row stagger. Kept from the previous hero: the window off the right and bottom, the status pill that crossfades its phrase on its own pill (`dark-hero`), the phone window fading out behind the card (`fade-crop`). Changed: the card races one read through opfs-lsm and through a baseline store, in the adapters figure's language (`Meter` accent against a gray bar, `Count` values, the verdict badge after `Running`). The bundle size and the keys are gone.

Beats: 1 the app reopens, its list a skeleton, the pill "Loading from disk" with a spinner, the card `Running` … 2 both bars grow for the same 1.8 s, as in the adapters figure, so opfs-lsm's fills and the baseline's stops at the ratio of the two rates … 3 both rates count in, the list resolves top to bottom, the pill settles on "Loaded from disk" … 4 the badge becomes the ratio. Plays once, about 5.5 s; the poster is the end, where the bar lengths still show the difference.

Captured: wide (600, on the real home page at 1280) and 390, light and dark, the reduced-motion poster at both widths, a 20-frame loop every 400ms at both widths in light and wide in dark. Earlier rounds also filmed `--states` at both widths.

Gate: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand), at both widths and in dark.

Film:
- `lopsided: span.ss-badge "Loading from disk…" has 5px on the left and 9px on the right` → stands. The kit's pill gives an icon 7px and the words 9px. The spinner's turning box is wider than its 12px ring.
- `clipped: span.ss-bar / svg clipped bottom by 3 to 5px by div.ss-window` (390) → stands. It is the filler row at the phone window's foot, under the fade and behind the card, not visible in any frame.
- Seen on the poster, not by the gate: a 3.6× badge beside "On-demand, 10 rows by id" ran past the card's right edge → the sidebar and the card both grew by 20px, so the card's edge stays on the sidebar line.
- Seen on the poster: both bars ended full, so the still lost the comparison → the bars grow for the same time and end at the ratio.

Review: no separate fresh-eye reviewer ran. Judged against `loading` and the previous hero:
- The eye lands on the three named issues and the card's green badge and accent bar. The badge is the payoff.
- The card sits 64px off the stage's foot, beside the named issues, so the ground above it is no longer a tall empty band.

Assumptions: the issue titles and assignees are examples. The card's figures are `read` from the home page's frontmatter: TanStack DB in on-demand mode, 10 rows by id, against TanStack DB's SQLite persistence. No duration is shown, because the README states rates, not times.

Unresolved:

Not checked: a real phone, Safari and Firefox, motion inside the film's sampling gaps, reduced motion toggled during playback, the Replay button. The film waited for page load, not network idle (the live demo's SharedWorker request never settles in headless Chrome). The dev server's file watcher delivered no changes, so every filmed run followed a restart of the server on port 5320.
