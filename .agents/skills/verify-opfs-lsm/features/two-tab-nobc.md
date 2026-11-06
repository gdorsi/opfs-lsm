# Two-tab without BroadcastChannel

Two-tab without BroadcastChannel runs the same peer put/ingest/get scenario while silencing `BroadcastChannel`, proving visibility still works through the WAL and SharedWorker path when BC posts are dropped.

## Sub-features

- `nobc-silence` replaces `BroadcastChannel` so posts are counted but never delivered.
- `nobc-scenario` runs the full two-tab scenario under SharedWorker.
- `nobc-bc-used` asserts the replacement saw at least one `postMessage`.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_NOBC=1` (pages get `?nobc=1`).
- Or open `two-tab.html?auto=1&role=a&nobc=1` plus peer `role=b&nobc=1`.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.

- **Run nobc two-tab.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-nobc`. Exit code `0`.
- **Confirm mode.** Stdout contains `mode=SharedWorker nobc` and `two-tab ok`.
- **Confirm BC stub.** Stdout contains `bc_posts=` with a positive count.
- **Proof.** Keep `artifacts/two-tab-nobc/<run-id>/stdout.txt` including `two-tab ok` and `bc_posts=`.

## Gotchas

- On main this drive exits 1 with `pinned get before ingest was null`, before `two-tab ok`. CI does not run it. The pass policy is [docs/verification.md](../../../../docs/verification.md).
- Run this together with `two-tab` when BroadcastChannel wiring changed. The default `two-tab` drive is the SharedWorker proof.
- Local EngineHost + nobc is a different combination; this feature drive uses SharedWorker with `TWO_TAB_NOBC=1` only.
