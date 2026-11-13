# Size cap across two tabs

Two tabs open a database with `maxBytes` and a handler each, and fill it past the cap. Only the tab holding the Web Lock `opfs-lsm-pressure/<name>` answers, once, with a range delete of the oldest rows; both tabs then read the rows left, under the cap. A second database with no handler warns once in each tab.

## Sub-features

- `pressure-one-answer`: the handlers run once in total, and both tabs read what the answer left.
- `pressure-warning`: with no handler, one warning in each tab and no row lost.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_PRESSURE=1` (`two-tab.html?scenario=pressure` as tab A and tab B, sharing the package SharedWorker).

## Driving it with verify-opfs-lsm

- **Run.** `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive pressure`, after `doctor: ok`. Exit code `0`.
- **Confirm.** Stdout contains `tabs=2`, `mode=SharedWorker`, `pressure answered by tab`, `both tabs read`, `no handler: one warning in each tab` and `pressure ok`.
- **Proof.** Keep `artifacts/pressure/<run-id>/stdout.txt`.

## Gotchas

- Which tab answers depends on which asked for the lock first. Either passes; two answers fail.
