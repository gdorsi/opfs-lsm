# Size cap from the storage quota

A tab fills a database, flushes, and the script sets the quota of the SharedWorker's `navigator.storage.estimate()` just under the usage. A handle opened with `maxBytes: "quota"` gets an offer and its handler range-deletes the oldest rows worth `need` bytes. The page then flushes after each answer and prints `estimate().usage` and the SST bytes at the handler, after it resolves, after the flush, after compaction settles, and on every change over 10 s, in ms since the first handler ran. It ends with the number of handler calls.

## Sub-features

- `quota-offer`: usage over 90% of the quota makes an offer whose `bytes` is the SharedWorker's `usage`.
- `quota-frees`: the answer brings `estimate().usage` down.
- `quota-calls`: the handler runs once per answer. More than one call means the host measured a state the first answer had already fixed; read the timeline for why.

## How to get to it (user POV)

- Run the two-tab script with `TWO_TAB_QUOTA=1` (`two-tab.html?scenario=quota` as tab A, with tab B open beside it).

## Driving it with verify-opfs-lsm

- **Run.** `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive quota`, after `doctor: ok`. Exit code `0`.
- **Confirm.** Stdout contains `tabs=2`, `mode=SharedWorker`, `handler 1 starts`, `handler calls: ` and `quota ok`.
- **Proof.** Keep `artifacts/quota/<run-id>/stdout.txt`, and report the timeline and the call count.

## Gotchas

- `Storage.overrideQuotaForOrigin` does not change `estimate()` in Chrome 157, so the script patches `StorageManager.prototype.estimate` in the SharedWorker over DevTools. Only its `quota` is simulated; `usage` is Chrome's.
- Chrome lists the one SharedWorker twice; the script patches both.
