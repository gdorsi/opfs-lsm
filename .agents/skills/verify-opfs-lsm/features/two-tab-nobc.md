# Two-tab without BroadcastChannel

Two-tab without BroadcastChannel runs the same scenario while silencing `BroadcastChannel` on the pages, so they never hear the SharedWorker's generation notes. It proves `sync()`, `ingest()` and reads of a tab's own writes do not depend on those notes.

## Sub-features

- `nobc-silence` replaces `BroadcastChannel` on the pages, so nothing is delivered to them.
- `nobc-scenario` runs the two-tab scenario under SharedWorker. The no-`sync()` visibility step is skipped (`visible_ms skipped`): without the note a tab learns of new generations only from its own calls.
- `nobc-bc-used` asserts the page opened at least one channel through the replacement.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_NOBC=1` (pages get `?nobc=1`).
- Or open `two-tab.html?auto=1&role=a&nobc=1` plus peer `role=b&nobc=1`.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.

- **Run nobc two-tab.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-nobc`. Exit code `0`.
- **Confirm mode.** Stdout contains `mode=SharedWorker nobc` and `two-tab ok`.
- **Confirm BC stub.** Stdout contains `bc_opened=` with a positive count.
- **Proof.** Keep `artifacts/two-tab-nobc/<run-id>/stdout.txt` including `two-tab ok` and `bc_opened=`.

## Gotchas

- CI does not run this drive.
- Run this together with `two-tab` when BroadcastChannel wiring changed. The default `two-tab` drive is the SharedWorker proof.
- Local Host + nobc is a different combination; this feature drive uses SharedWorker with `TWO_TAB_NOBC=1` only.
