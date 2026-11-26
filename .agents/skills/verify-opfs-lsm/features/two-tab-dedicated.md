# Two-tab with a dedicated Worker host per tab

Two tabs with no `SharedWorker` in the page run the two-tab scenario, so each handle starts its own dedicated Worker and several hosts flush and compact one database. A second drive has those hosts stage their files through a sync access handle and a rename, the way a host writes where OPFS has no `createWritable()`.

## Sub-features

- `dedicated-hosts` removes `SharedWorker` from each page before it opens a database, so the harness starts the testing worker as a dedicated `Worker`, one per handle.
- `dedicated-writes` asks the testing worker for a host that writes run files in a dedicated Worker. The worker an app loads writes none there.
- `dedicated-scenario` runs the full two-tab scenario: each tab's flush goes to its own host and raises the generation the other tab reads.
- `staged-writer` hides `createWritable()` in the testing worker, so its probe writes a scratch file and the host stages every run, manifest and reserve file.
- `host-writes` reads from the host's stats how it wrote its files: `writable` or `staged`.
- `shipped-dedicated` opens one database through `openDb` with no `SharedWorker`: the shipped worker's host writes no file, and the row still reads.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_HOSTS=dedicated`, and with `TWO_TAB_STAGED=1` for the staged writer (pages get `?hosts=dedicated` and `&staged=1`).
- Or open `two-tab.html?auto=1&role=a&hosts=dedicated` plus the peer `role=b&hosts=dedicated`.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.

- **Run dedicated hosts.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-dedicated`. Exit code `0`.
- **Confirm mode.** Stdout contains `mode=dedicated Worker`, `SharedWorker=false` and `host writes=writable` with a positive `flushes=`.
- **Run the staged writer.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-staged`. Exit code `0`.
- **Confirm mode.** Stdout contains `mode=dedicated Worker staged` and `host writes=staged` with a positive `flushes=`.
- **Confirm scenario.** Both logs contain `two-databases ok`, `shipped-worker ok` and `two-tab ok`.
- **Proof.** Keep `artifacts/two-tab-dedicated/<run-id>/stdout.txt` and `artifacts/two-tab-staged/<run-id>/stdout.txt`.

## Gotchas

- CI does not run these drives.
- The two flags reach the testing worker only, in the fragment of its URL (`packages/kv/proof/host-modes.ts`). They are not `openDb` options, and the worker an app loads does not read them.
- `TWO_TAB_STAGED=1` needs `TWO_TAB_HOSTS=dedicated`. Chrome gives a sync access handle to a dedicated Worker only, so a staged SharedWorker host would write no file there. The script exits `1` without the pair.
- `host writes=` is the proof that the staged writer ran. A run that reads `writable` under `two-tab-staged` did not test it.
- These drives prove that several hosts keep one database consistent. They open with `reserveBytes: 0`, so they say nothing about the reserve, which several hosts do not share (`docs/reserve.md`, "Several hosts").
- The kill loop takes the same modes: `pnpm --filter @opfs-lsm/kv kill-chrome --hosts dedicated [--staged]` (`docs/verification.md`, "Kill real Chrome"). Its `quota` kind fails there at a small `maxWalBytes`, for a reason `docs/verification.md` lists under "Gaps".
