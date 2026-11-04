# Two-tab local EngineHost

Local EngineHost runs the two-handle put/ingest/get scenario inside one page with a shared in-page `EngineHost` and BrowserFs, without a SharedWorker. Use it to prove the local ingest client path, not multi-tab SharedWorker coordination.

## Sub-features

- `local-open` opens two handles on one OPFS BrowserFs and one local ingest client.
- `local-scenario` runs the same pin / fresh get / range / reverse-get checks as SharedWorker two-tab.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_LOCAL=1` (single page, `?local=1`).
- Or open `two-tab.html?auto=1&local=1&name=two-tab`.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.

- **Run local two-tab.** Execute `.cursor/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-local`. Exit code `0`.
- **Confirm one page.** Stdout contains `tabs=1`.
- **Confirm local mode.** Stdout contains `mode=local EngineHost` and `two-tab ok`.
- **Proof.** Keep `artifacts/two-tab-local/<run-id>/stdout.txt`. Do not label this run as SharedWorker proof.

## Gotchas

- Exactly one page is expected. Seeing `tabs=2` means the wrong drive ran.
- Changes to SharedWorker port protocol are not covered here — use `two-tab` for that.
- Still uses real OPFS BrowserFs in Chrome; it is not a MemoryFs unit test.
