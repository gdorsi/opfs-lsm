# Storage full: the reserve and `onStorageFull`

Two tabs open a database with a 16 MiB reserve and a handler each, and flush 640 rows. The script then sets a real limit on the origin's storage, 256 KiB over the usage, with `Storage.overrideQuotaForOrigin`. The next flush is refused, lands on the reserve the host releases, and one tab's handler range-deletes the older three quarters of the rows. The page prints the origin's usage, the SST bytes and the size of the reserve file at each step, in ms since the limit. A second database with no handler warns once in each tab, and gets its reserve back when the limit is lifted.

## Sub-features

- `quota-refused`: under the limit, an OPFS write of 512 KiB fails with `QuotaExceededError`.
- `quota-one-answer`: the handlers run once in total, with the reserve file gone, and both tabs read the rows the answer left.
- `quota-reserve-back`: the SST bytes and the origin's usage end lower, and the reserve file is back at 16 MiB under the same limit.
- `quota-warning`: with no handler, one warning in each tab and no row lost.
- `quota-fill-time`: the time to write a 24 MiB reserve, three times.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_QUOTA=1` (`two-tab.html?scenario=quota` as tab A and tab B, sharing the package SharedWorker).

## Driving it with verify-opfs-lsm

- **Run.** `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive quota`, after `doctor: ok`. Exit code `0`.
- **Confirm.** Stdout contains `tabs=2`, `mode=SharedWorker`, `OPFS write is refused`, `storage full answered once, by tab`, `the reserve file is back`, `no handler: one warning in each tab, no row lost`, `limit lifted: the reserve file is back` and `quota ok`.
- **Proof.** Keep `artifacts/quota/<run-id>/stdout.txt`, and report the timeline and the fill times.

## Gotchas

- The override ends with the DevTools session that set it, so the script keeps one session open on tab A.
- Chrome applies the override to OPFS writes only. IndexedDB commits pass it, so the drive never refuses a WAL append: `tests/wal-full.test.ts` covers that path.
- The WAL in IndexedDB counts in the origin's usage, and Chrome frees it late. A handler that frees little more than it wrote is asked again, because the reserve does not fit yet. The drive's handler frees three quarters of the rows, so one answer is enough.
- Which tab answers depends on which asked for the lock first. Either passes; two answers fail.
