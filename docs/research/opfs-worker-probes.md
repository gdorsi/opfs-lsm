# OPFS worker probes: locks, handles, SharedWorkers and bfcache

Run 2026-11-09 on an Apple M5 Max (macOS):
- Chrome 156, headless, through [`drive-chrome.mjs`](opfs-worker-probes/drive-chrome.mjs).
- Safari 26.6.2 and Firefox 157, opened by hand.

Probe: [`docs/research/opfs-worker-probes/`](opfs-worker-probes/). Raw results are written to its `results/` folder, which is gitignored.

Any write path where several tabs write OPFS files and another context reads, reclaims or takes over those files must answer the same questions. When is a writer really gone? Can a reader see a file while it is being written? Can a cached page keep holding what others wait for? PR #97 (per-tab logs) answers them with a liveness protocol. These probes measure what the browsers actually do.

## Web Locks and SyncAccessHandles

### A worker's lock is released only after its writes stop

Probe P1+P2: a dedicated WebWorker holds a Web Lock and overwrites chunks of a file through a SyncAccessHandle. Each chunk is stamped with a write counter. The page calls `terminate()` while a write is in flight, then requests the same lock. Once the lock is granted, it reads the highest counter, waits 500 ms, and reads it again.

| | Chrome | Safari | Firefox |
|---|---|---|---|
| Rounds with a write after the lock was granted (1, 16 and 64 MiB chunks, 2 rounds each) | 0 of 6 | 0 of 6 (2 runs) | 0 of 6 |
| Time from `terminate()` to lock granted | **2.0–2.7 s** | 0–38 ms | 0–1 ms |
| Torn chunks at grant | 0 | 0 | 0 |
| File reopenable by another worker after grant | yes | yes | yes |

- **No write ever landed after the lock was released.** So taking a writer worker's lock is a safe sign that it can no longer write its files. That only holds if the worker itself holds the lock: a lock held by the page says nothing about a worker that is still running.
- **This makes the lock a fence even where deletion isn't one.** Safari lets `removeEntry` delete a file while a handle is open on it, as measured in #97's earlier cross-browser probe (`architecture/wal-opfs/03-cross-browser-probe.md` on that branch). Deleting a file after taking its writer's lock is safe in all three browsers. Deleting it while relying on the delete to fail is not.
- **Chrome takes about 2 s to release a worker that is busy in sync writes.** Safari and Firefox release at once. Timeouts that wait for a terminated writer must allow for Chrome's 2 s.
- **Untested:** a write blocked by an exhausted quota, which can hang in Chrome, rather than a slow one. The full-quota probe (P2b) needs a profile with a small quota and has not been run.

### A page in bfcache can keep its lock and its handle

Probe P7: a page whose worker holds a lock and a handle navigates away. The next page checks `navigator.locks.query()` and tries to open the file. Then it goes back.

| | Chrome (headless) | Safari | Firefox |
|---|---|---|---|
| Page bfcached | Yes at first, then evicted (see below) | **Yes in 1 of 2 attempts** | No: unloaded |
| Lock shown as held while away | Yes | Yes, when bfcached | No |
| File handle held while away | No: another worker opened it | **Yes**: `InvalidStateError` | No |
| Reported reason | `WebLocksContention` | — | — |

- **Safari can bfcache a page whose worker holds a lock and a handle, and keeps both held while the page is cached.** Whether it does is decided per navigation: it happened in one of two attempts. A design where other tabs wait on every live tab will stall for as long as Safari keeps such a page.
- **Chrome put the page in bfcache with its lock still held, then evicted it when another worker opened its file.** It reported `WebLocksContention` as the reason it didn't restore the page. Our reading, inferred from that reason and not probed separately: Chrome evicts a cached page when another context needs what it holds, while a passive `locks.query()` doesn't trigger eviction. So a protocol that only queries locks can still see a cached tab as alive.
- **Firefox unloads the page, and the lock and handle are released within 1 s.**
- **Handling.** On `pagehide` with `persisted: true`, a tab should flush, close its handles and release its locks. On `pageshow` it should start over as a new writer. Nothing in the repo does this yet.

## SharedWorker reads of a file being written

Probes P4+P6: a dedicated WebWorker appends fixed-size frames to a file and flushes every 100 ms. A SharedWorker reads the whole file with `getFile()` + `arrayBuffer()` in a loop for about 3 s. Frames are checked for order and completeness.

| Append rate (128 B frames) | Chrome: share of reads failing with `NotReadableError` | Chrome: longest time with no successful read | Safari | Firefox |
|---|---|---|---|---|
| 100/s | 0.9–1.3% | 20–28 ms | never fails | never fails |
| 1k/s | 10–14% | 16–25 ms | never fails | never fails |
| 10k/s | 83–95% | 21–43 ms | never fails | never fails |
| unpaced (250k–300k/s) | 99% | 0.16–2.1 s | never fails | never fails |

- **No browser exposed a later whole frame before an earlier one.** Readers never saw bytes out of write order, and a read never went backwards.
- **Chrome refuses to read a file while it's being written:**
  - At realistic `put` rates, retrying is enough.
  - Under a burst it can refuse for seconds. So a reader that must make progress needs files that stop changing: sealed segments, or a way to ask the writer to seal.
- **Safari returns a snapshot. Firefox returns live bytes,** and there `File.size` often disagrees with the length of the bytes read. A reader must take the bytes it got as the truth, not `File.size`, and treat a partial frame at the end as the end.

## SharedWorker reconnect after `close()`

Probe P5: a SharedWorker calls `self.close()`, and the page immediately creates a new `SharedWorker` with the same name and URL.

| Delay before reconnecting | Chrome | Safari | Firefox |
|---|---|---|---|
| 0 ms | **Silent**: attaches to the dying instance, no reply in 3 s. A retry gets a fresh one | Silent in 1 of 2 runs; retry works | Silent; retry works |
| 50 ms, 500 ms | Fresh, replies in 2–8 ms | Fresh | Fresh |

- **Reconnecting straight after a SharedWorker dies can attach to the dying instance, which never answers.** Code that restarts a SharedWorker needs a reply timeout and a retry.

## Quota

Probe P3: write 64 MiB through a handle, flush, close, `removeEntry`, then poll `navigator.storage.estimate()`.

| | Chrome | Safari | Firefox |
|---|---|---|---|
| `estimate().usage` drops after the delete | within 2 ms | **not within 2 s** (2 runs) | within 2 ms |

- **Safari's estimate doesn't reflect a delete within 2 s.** That may only be a cached estimate. Whether a write succeeds again after freeing space under a full quota is the full-quota probe (P2b/P3b), which has not been run.

## Not covered

- Full quota (P2b/P3b) in any browser.
- Mobile browsers, and Chrome with a visible window (bfcache rules can differ from headless).
- Each result is one or two runs per browser. Rates and times are from those runs, not distributions.
