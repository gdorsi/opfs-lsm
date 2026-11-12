# Size cap across two tabs

A database opened with `maxBytes` and filled past it gets one pressure offer, and only the tab holding the Web Lock `opfs-lsm-pressure/<name>` runs its `onPressure` handler. The handler removes the oldest rows with one range delete, and both tabs then read the rows it left. With no handler in either tab, each tab logs one warning for the offer.

## Sub-features

- `pressure-one-answer` registers an oldest-first handler in both tabs, writes about 25 MiB past a 16 MiB cap, and checks that the handlers ran once in total.
- `pressure-reads` checks that both tabs read exactly the rows written after the offer's `through`, and that they fit under the cap.
- `pressure-warning` opens a second database with `maxBytes` and no handler in either tab, fills it past the cap, and checks one warning in each tab and no row lost.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_PRESSURE=1` (headless Chrome opens `two-tab.html?scenario=pressure` as tab A and tab B, sharing the package SharedWorker).

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`, after `launch` rebuilt `dist`.

- **Run.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive pressure`. Exit code `0`.
- **Confirm two pages over the SharedWorker.** Stdout contains `tabs=2` and `mode=SharedWorker`.
- **Confirm one answer.** Stdout contains `pressure answered by tab` and `both tabs read`.
- **Confirm the warning.** Stdout contains `no handler: one warning in each tab` and `pressure ok`.
- **Proof.** Keep `artifacts/pressure/<run-id>/stdout.txt` and `exit_code.txt`.

## Gotchas

- The host raises a smaller `maxBytes` to 16 MiB, so the scenario writes 25 MiB per database; a slow disk needs the 120 s timeout the script sets.
- The scenario needs BroadcastChannel and two tabs. It does not run with `TWO_TAB_NOBC=1` or `TWO_TAB_LOCAL=1`.
- Which tab answers depends on which asked for the lock first. Either is a pass; two answers are a failure.
