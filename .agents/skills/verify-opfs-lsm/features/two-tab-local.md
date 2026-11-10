# Two-tab local Host

Local Host runs the two-handle scenario inside one page with one `Host` (from `@opfs-lsm/kv/testing`) on the page over BrowserFs, without a SharedWorker. Each handle's log is still written by its own dedicated WebWorker. Use it to prove the in-page host path, not multi-tab SharedWorker coordination.

## Sub-features

- `local-open` opens two handles on one OPFS BrowserFs and one `Host` on the page.
- `local-scenario` runs the same checks as SharedWorker two-tab, `visible_ms=` included.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_LOCAL=1` (single page, `?local=1`).
- Or open `two-tab.html?auto=1&local=1&name=two-tab`.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.

- **Run local two-tab.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-local`. Exit code `0`.
- **Confirm one page.** Stdout contains `tabs=1`.
- **Confirm local mode.** Stdout contains `mode=local Host` and `two-tab ok`.
- **Proof.** Keep `artifacts/two-tab-local/<run-id>/stdout.txt`. Do not label this run as SharedWorker proof.

## Gotchas

- CI does not run this drive.
- Exactly one page is expected. Seeing `tabs=2` means the wrong drive ran.
- Changes to SharedWorker port protocol are not covered here — use `two-tab` for that.
- Still uses real OPFS BrowserFs in Chrome; it is not a MemoryFs unit test.
