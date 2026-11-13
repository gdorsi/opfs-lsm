# Rehearsal: sync

Gold: `subscriptions` (a system story, a card straddling a browser window). Kept: a card in front of a window off the right and bottom, its right edge on the window's sidebar line, newest rows opening at the top and carrying the rest down, no cursor. Changed: the window is an app's issue list with its sync status, the card is `@opfs-lsm/kv` led by its bundle size, with the keys it was given and the SharedWorker's flush; nothing flies between them, the keys match the issue titles instead. The status pills follow `dark-hero`: the phrase crossfades on its own pill, which changes on its right edge only. The phone window fades out behind the card as in `fade-crop`.

Beats: 1 the app is Synced, kv holds `issue:dark-mode` … 2 Syncing … 3 "Offline mode" opens in the list, `issue:offline-mode` opens in kv (accent while in flight) and is acked … 4 the same for "Fix login redirect" … 5 Synced … 6 the SharedWorker is flushing to OPFS, then flushed. Plays once, about 8 s; the poster is the end.

Captured: wide (600, on the real home page at 1440) and 390, light and dark, `--states` at both, the reduced-motion poster at both, close-ups of the flush pill and of a key's insert every 60 ms, and the hero at 1280, 1200, 1024, 768, 600 and 360.

Gate: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)

Film:
- `framing: div.ss-window shows 304x411, narrower than tall` (390) → what shows of the phone window stays landscape, so it can't run off the bottom. Passed after.
- `uneven gutters` and `whole but off center` on the phone window, when it was whole with its foot under the card → the phone window runs off the right again and fades out above its foot, behind the card. Passed after.
- `uneven gutters: section.sy-kv` (390) → the phone card spans the stage at one 20px gutter. Passed after.
- `hard edge: span.ss-bar … sy-keys` and `uneven padding: section.sy-kv` (both widths) → the filler keys close in a Collapse as the new keys open, so the list keeps three rows. Passed after.
- `hard edge … sy-window` (390) → the phone list stops short of the window's foot. Passed after.
- `clipped` and `hard edge` on the status icon, when its cell clipped the spinner → the cell doesn't clip. Passed after.
- `lopsided: span.ss-badge "SyncingSynced" has 5px on the left and 9px on the right` → stands. The kit's pill gives an icon 7px and the words 9px; the spinner's turning box is 17px across, so it measures 2px past its 12px ring.

Review (fresh eye, against the gold), fixed:
- The phone window's foot and corner showed right of the card, with half avatars along the card's edge → the window fades out behind the card, and its content stops on the card's right edge.
- The wide list stopped six rows down at the opening, leaving an empty pane → it runs off the stage's foot from the first frame.
- The size was a gray subtitle → it leads the card at 22px.
- Named issues carried gray discs like the filler → they carry their assignees' monograms.
- Two keys stayed accent at rest → a key is accent only while its write is in flight.
- The status words rolled, showing two lines at once and cutting the "y" of "Synced" → the phrase crossfades in one cell.
- A key's rule and the footer's drew a double line as a row slid down → the key list fades over its last 6px.

Review, not taken:
- A time on each ack ("acked 0.4 ms"): it would be a number the README doesn't state, and the home page's numbers all come from it.
- A product URL and sidebar labels: "localhost" stands for the reader's own app.

Assumptions: the keys, issue titles, assignees and the order of ack and flush are examples; an ack is the write's row in the WAL and the flush is the SharedWorker writing SST files to OPFS (design.md, "Flush"). The size is the home page's `size.main`.

Unresolved:

Not checked: a real phone, Safari and Firefox, motion inside the film's sampling gaps, reduced motion toggled during playback, the Replay button. The film waited for page load, not network idle: the live demo's SharedWorker request never settles in headless Chrome, so the stock script times out on this page.
