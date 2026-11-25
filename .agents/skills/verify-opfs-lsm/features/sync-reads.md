# Sync reads through a dedicated worker

`openDb` with `syncReads` (imported from `@opfs-lsm/kv/sync-reads`) reads run files synchronously: a dedicated worker holds a read-only sync access handle on each one and answers through a SharedArrayBuffer. The two-tab and the destroy scenarios run with every database opened that way, on pages served cross-origin isolated. Reads are served synchronously, and `destroyDb` still removes a folder whose run files other tabs hold open.

## Sub-features

- `sync-reads-served`: tab A's `readStats` reports run-file reads served synchronously after the two-tab scenario's gets and scans.
- `sync-reads-remove-second`: `destroyDb` of the second database name removes its folder while both tabs hold handles on its run files.
- `sync-reads-destroy`: the whole destroy scenario, with the tab that calls `destroyDb` and the tab that holds a view both reading synchronously first. A handle left open on a run file would fail the folder's removal with `NoModificationAllowedError`.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_SYNC_READS=1`, alone or with `TWO_TAB_DESTROY=1`. Pages get `?sync=1`, which imports the sync-reads entry and passes it to every open, and the script serves them with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

## Driving it with verify-opfs-lsm

- **Run.** `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive sync-reads`, then `drive sync-reads-destroy`, after `doctor: ok`. Exit code `0` for each.
- **Confirm `sync-reads`.** Stdout contains `tabs=2`, `mode=SharedWorker`, `run-file reads served synchronously: ` with a positive count, `sync-reads ok`, `two-databases ok` and `two-tab ok`.
- **Confirm `sync-reads-destroy`.** Stdout contains `both tabs hold the run files open for sync reads`, `sync-reads ok`, and every proof string of [destroy](./destroy.md), ending in `destroy ok`.
- **Proof.** Keep `artifacts/sync-reads/<run-id>/stdout.txt` and `artifacts/sync-reads-destroy/<run-id>/stdout.txt`.

## Gotchas

- Chromium only. Another browser opens the database and reads the async way, and the script fails on the missing `sync-reads ok` line.
- Without the two headers the page has no `SharedArrayBuffer`, and the reads go the async way with no error.
- The `crashed tab` and `tab navigated away` passes of the destroy scenario end a page whose worker holds handles. The browser releases them with the page, not kv.
- Run `two-tab` and `destroy` as well: they prove the option off.
