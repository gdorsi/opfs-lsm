# Two-tab SharedWorker visibility

Two-tab visibility: each tab writes to its own OPFS log, the SharedWorker ingests the logs into SST files, and a tab sees another tab's write once it is ingested: after `sync()`, or about a second later on its own. A view keeps reading the state it opened on while the other tab writes and ingests.

## Sub-features

- `two-tab-own` reads its own write at ack, then ingests so SST readers are warm before the peer write.
- `two-tab-sync` puts `k=v` from the peer tab into the peer's log; the leader's `sync()` makes it visible.
- `two-tab-pin` holds a view while the peer puts `k=v2` and ingests, and still reads `k=v`.
- `two-tab-fresh` reads `k=v2` after `sync()`.
- `two-tab-visible` times five peer writes until the leader reads them with no `sync()` (`visible_ms=`): the SharedWorker's latency round and its BroadcastChannel note, about a second.
- `two-tab-range` finds `k` in a range scan.
- `two-tab-reverse` puts from the leader and gets from the peer after `sync()`.

## How to get to it (user POV)

- Run the package two-tab script (headless Chrome opens tab A and tab B on `two-tab.html`).
- Or open `packages/kv/proof/two-tab.html?auto=1&role=a` and a second page with `role=b` against a built `dist` served over HTTP (the script does this).

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.
- No need to clear OPFS manually; the harness uses a disposable Chrome profile.

- **Run SharedWorker two-tab.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab`. Exit code `0`.
- **Confirm two pages.** Stdout contains `tabs=2`.
- **Confirm SharedWorker mode.** Stdout contains `mode=SharedWorker` and does not claim local Host as the only mode.
- **Confirm scenario.** Stdout contains `own write at ack; warm seed generation=`, `sync k=v`, `pinned generation=`, `fresh k=v2`, `visible_ms=`, `range has k`, `other tab saw after=yes`, and `two-tab ok`.
- **Proof.** Keep `artifacts/two-tab/<run-id>/stdout.txt` and `exit_code.txt`. The log must include `two-tab ok` and `tabs=2`.

## Gotchas

- Missing `dist` fails before Chrome opens — run `launch` first.
- Headless background throttling breaks tab B ingest; the harness already passes `--disable-background-timer-throttling` and related flags. Do not strip them.
- `TWO_TAB_LOCAL=1` is a different feature (`two-tab-local`). It must not be reported as SharedWorker proof.
- Success is the `two-tab ok` line, not merely Chrome exiting.
