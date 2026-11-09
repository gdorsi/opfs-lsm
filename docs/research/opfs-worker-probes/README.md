# OPFS worker probes

Browser facts about Web Locks, SyncAccessHandles, SharedWorkers and bfcache that a multi-tab OPFS write path relies on. Findings: [`docs/research/opfs-worker-probes.md`](../opfs-worker-probes.md).

```sh
node docs/research/opfs-worker-probes/serve.mjs        # http://localhost:8787/
node docs/research/opfs-worker-probes/drive-chrome.mjs http://localhost:8787   # every probe in headless Chrome, P7 included
```

Open `http://localhost:8787/` in each browser (a fresh profile is best) and press **Run P1–P6**. Results show on the page and are saved to `docs/research/opfs-worker-probes/results/<browser>-<time>.json`. `results/` is gitignored. `?auto` runs them on load (used for headless Chrome).

| Probe | Question | Fails when |
|---|---|---|
| P1+P2 | Is a worker's Web Lock released only after its sync writes can no longer land, including on `terminate()` mid-write? | A chunk counter rises after another context is granted the lock, or the lock is not released within 10 s |
| P3 | Does `removeEntry` free quota at once? | `estimate().usage` doesn't drop within 2 s |
| P4+P6 | Can a SharedWorker read a file another worker keeps appending to? Are bytes exposed in write order? How often does Chrome throw `NotReadableError`? | A whole later frame is visible before an earlier one, or no read ever succeeds |
| P5 | After a SharedWorker calls `close()`, is the next `new SharedWorker()` a fresh, responsive instance? | The new instance never answers, or has the old id |
| P2b+P3b (button) | Under a full quota: does `flush()` hang, and can writing resume after freeing a reserve file? | Needs a profile with little free quota; skipped above the cap |
| P7 (button) | Does a page whose worker holds a lock and a handle enter bfcache, and does it keep them while away? | Manual: navigate away, then press Back |
