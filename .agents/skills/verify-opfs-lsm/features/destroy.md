# destroyDb with other tabs open

One tab fills a database and calls `destroyDb` while a second tab holds it open with a `view` running. Both handles close with a `closed` event whose reason is `"destroyed"`, the second tab's `put` and the view's next cold read reject with `ClosedError`, the WAL database and the OPFS folder are gone, and an open after it reads empty with seqs and manifest numbers past the old ones. `destroyDb` on a name never opened leaves nothing. Then a tab holding a database open crashes, freezes, or navigates away, and `destroyDb` runs past it.

## Sub-features

- `destroy-live-tab`: the other tab's handle closes, its put and view read reject with `ClosedError`, and no store is left.
- `destroy-reborn`: the reopened database reads empty, and its first seq and manifest number lie past the old head and top.
- `destroy-never-opened`: no WAL database, no folder and no `opfs-lsm-destroyed` row for a name never opened.
- `destroy-crashed-tab`: a tab killed with DevTools `Page.crash` does not hold the version fence.
- `destroy-frozen-tab`, `destroy-bfcache-tab`: facts, logged. A tab frozen with `Page.setWebLifecycleState` holds `destroyDb` until it resumes. A tab in the back/forward cache is evicted by the `versionchange`, so `destroyDb` does not wait.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_DESTROY=1` (`two-tab.html?scenario=destroy` as tab A). Tab A asks the script, over `/cdp`, to open holder tabs (`two-tab.html?role=holder`) and to crash, freeze, resume, navigate and read them through DevTools.

## Driving it with verify-opfs-lsm

- **Run.** `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive destroy`, after `doctor: ok`. Exit code `0`.
- **Confirm.** Stdout contains `tabs=`, `mode=SharedWorker`, `other tab closed reason=destroyed`, `other tab put and view read rejected with ClosedError`, `wal database gone`, `folder gone`, `reopened empty`, `never-opened left nothing`, `crashed tab: destroyDb finished`, `frozen tab: `, `tab navigated away: ` and `destroy ok`.
- **Proof.** Keep `artifacts/destroy/<run-id>/stdout.txt`.

## Gotchas

- The frozen pass waits 10 s on purpose before it resumes the tab.
- The script serves files with `cache-control: no-cache` in this scenario only: `no-store` keeps a page out of the back/forward cache, and the bfcache pass would test nothing.
- A holder page that reloads (after an eviction or a discard) does not open its database again, or it would undo the removal.
