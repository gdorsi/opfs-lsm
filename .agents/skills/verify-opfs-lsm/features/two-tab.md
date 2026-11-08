# Two-tab SharedWorker visibility

Two-tab visibility lets one tab put and ingest while another tab keeps a pinned view, then both tabs agree on the key after ingest through the SharedWorker and OPFS SST path.

## Sub-features

- `two-tab-warm` seeds and ingests so SST readers are warm before the peer write.
- `two-tab-peer-put` puts `k=v` from the peer tab into the shared IndexedDB WAL.
- `two-tab-pin` holds a view across peer ingest and still reads `k=v`.
- `two-tab-fresh` reads `k=v` on a fresh get after ingest.
- `two-tab-range` finds `k` in a range scan after ingest.
- `two-tab-reverse` puts from the leader and gets from the peer after ingest.

## How to get to it (user POV)

- Run the package two-tab script (headless Chrome opens tab A and tab B on `two-tab.html`).
- Or open `packages/kv/proof/two-tab.html?auto=1&role=a` and a second page with `role=b` against a built `dist` served over HTTP (the script does this).

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.
- No need to clear OPFS manually; the harness uses a disposable Chrome profile.

- **Run SharedWorker two-tab.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab`. Exit code `0`.
- **Confirm two pages.** Stdout contains `tabs=2`.
- **Confirm SharedWorker mode.** Stdout contains `mode=SharedWorker` and does not claim local EngineHost as the only mode.
- **Confirm scenario.** Stdout contains `warm seed generation=`, `pinned generation=`, `fresh k=v`, `range has k`, `other tab saw after=yes`, and `two-tab ok`.
- **Proof.** Keep `artifacts/two-tab/<run-id>/stdout.txt` and `exit_code.txt`. The log must include `two-tab ok` and `tabs=2`.

## Gotchas

- Missing `dist` fails before Chrome opens — run `launch` first.
- Headless background throttling breaks tab B ingest; the harness already passes `--disable-background-timer-throttling` and related flags. Do not strip them.
- `TWO_TAB_LOCAL=1` is a different feature (`two-tab-local`). It must not be reported as SharedWorker proof.
- Success is the `two-tab ok` line, not merely Chrome exiting.
