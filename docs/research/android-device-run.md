# kv on an Android phone: what runs, what does not, and how to drive it

Run 2026-11-13 at `d71e997` on a Pixel 4a (8 cores, 6 GB of RAM) with LineageOS 23.2 (Android 16), a `userdebug` image, over adb from a Mac:
- Chromium 160.0.8160.0, the official snapshot builds 1744029 and 1744109 for Android arm64, installed for the run.
- Android System WebView 154.0.8037.57, the WebView the phone ships, through the Jelly browser.

Tools: [`docs/research/android-device-run/`](android-device-run/). Its README has the commands, and `run.mjs` there runs everything below in one command. Raw logs are written to its `results/` folder, which is gitignored.

Until this run the engine had only been driven in desktop Chrome. Three questions needed a real phone. Does kv open in the browsers an Android phone has? Do the SharedWorker, OPFS and Web Lock behaviors the design relies on hold there? Does a kill lose an acked write?

- **kv works in Chromium 160 on the phone.** The two-tab proofs, every bench workload, and the kill loop's recovery check all pass.
- **kv does not open in the phone's own WebView.** WebView 154 has no SharedWorker.
- **Android schedules the SharedWorker by the tab that created it.** When another tab of the app is in front, the worker's process is confined to two small cores.
- **A locked phone confines the whole browser to those two cores.** Results still pass, phases take 2.4 to 3.6 times longer, and an explicit `ingest()` can outlast 20 s.

## The phone's WebView has no SharedWorker

[`probe.mjs`](android-device-run/probe.mjs) opens one page that reports each API and then calls `openDb`.

| | WebView 154 (Jelly) | Chromium 160 |
|---|---|---|
| `typeof SharedWorker` | **`undefined`** | `function` |
| OPFS `createWritable()` in the page | works | works |
| OPFS `createWritable()` in a module SharedWorker | no SharedWorker | works |
| IndexedDB, Web Locks, BroadcastChannel, `crypto.randomUUID()`, WebAssembly | present | present |
| `openDb`, then put and get | **rejects with `StorageUnavailableError`** | returns the value |
| `two-tab-local` (engine hosted in the page, a test-only setup) | passes | passes |

- **Every app and browser built on this WebView is out.** `openDb` rejects there, as it is documented to do without SharedWorker. Jelly is one such browser.
- **MDN says otherwise.** browser-compat-data 8.1.8 marks `webview_android` as a mirror of `chrome_android` for `SharedWorker`, which gives 148. The measured WebView is 154.
- **Only the missing SharedWorker stops kv.** With the engine hosted in the page, the two-tab scenario passes in the WebView: OPFS files, the IndexedDB WAL and the wasm engine all work.
- **Untested:** Google's WebView build. The measured one is the LineageOS build.

## Chromium on the phone passes the Chrome proofs

Every row ran the repo's own harness, with [`android-chrome.mjs`](android-device-run/android-chrome.mjs) in place of the Chrome binary.

| Check | Runs | Result |
|---|---|---|
| `two-tab` and `two-tab-nobc`, with the harness's anti-throttling flags | 7 | pass |
| `two-tab` and `two-tab-nobc`, without those flags | 14 | pass |
| `two-tab-local` | 3 | pass |
| `bench smoke`: every workload of every family at 1,000 entries | 2 full runs of 35 | pass, every read checked |
| `bench run kv/ --size small --contenders kv`: 100,000 entries | 3 runs of 12 | pass, every read checked |

- **The background tab does not need the anti-throttling flags.** A phone shows one tab, so tab A is hidden once tab B opens. With or without the flags, the scenario took 750 to 902 ms in the 16 SharedWorker runs on the locked phone and 327 to 422 ms in the 5 on the unlocked phone.
- **Flush and compaction ran on the phone's flash.** After `kv/fillrandom` at 100,000 entries the report shows 12.5 MB of WAL, 11.7 MB flushed and 16.9 MB compacted, for 11.6 MB on disk.
- **A partial rerun on `5d08cca`, 147 commits later, passed what it reached:** the probe, `two-tab`, `two-tab-nobc`, `two-tab-local` and all 39 runs of `bench smoke`. The phone then dropped off USB, so `bench run kv/` and `kill-chrome` did not rerun there. One `two-tab` launch in that run missed the harness's 10 s wait for devtools. Its cause was not found.
- **One more smoke run stopped at run 25 on an adb error,** not on a check: one adb call could not reach the adb server. `android-chrome.mjs` now retries a failed call.

## A kill loses no acked write

`kill-chrome` ran with its four platform probes, then seeded iterations. Each iteration opens two or three tabs on one database, kills one thing, relaunches Chromium on the same profile, and checks every key.

| Probe (3 runs each) | Result |
|---|---|
| `tab-locks`: locks of a crashed tab | free after 15 to 23 ms |
| `worker-locks`: locks of a closed SharedWorker | free after 5 to 11 ms, and the next tab gets a new SharedWorker that ingests |
| `writable-tab-crash`: a tab crashed mid-`createWritable` | the target file is unchanged |
| `writable-browser-kill`: the browser killed mid-`createWritable` | the target file is unchanged. A `browser.bin.crswap` entry is listed next to it after the relaunch. |

| Kind | Runs | Recovery check | Iteration result |
|---|---|---|---|
| `close-worker` | 12 | 12 pass | 12 pass |
| `kill-browser` (the app force-stopped) | 12 | 12 pass | 12 pass |
| `browser-crash` | 8 | 8 pass | 8 pass. A ninth hung, see the harness limits. |
| `quota` | 16 | 16 pass | 11 pass, 5 fail on a locked phone, see below |
| `page-crash` | 3 | 3 pass | 3 fail in the harness, see the harness limits |
| `kill-renderer` | not run | | |

- **The recovery check passed in every iteration that reached it,** the failed ones included: every ack the harness saw is in the log, and the state equals the fold of the log.
- **A force-stop left at most 6 orphan files and no swap file** for the next open to remove.

## Android schedules the SharedWorker by the tab that created it

[`worker-cpuset.mjs`](android-device-run/worker-cpuset.mjs) opens a tab whose SharedWorker spins, then a second tab on the same worker, and reads each process's cpuset. On this phone `top-app` is cpus 0 to 7 and `background` is cpus 4 and 5, two of the six small cores.

| Phone unlocked | Process that hosts the SharedWorker | Its CPU use |
|---|---|---|
| One tab, in front | `top-app`, cpus 0-7 | 103% |
| Second tab opened, first tab behind it | **`background`, cpus 4-5** | 96 to 103% |

- **The worker runs in the first tab's renderer process and keeps its scheduling.** Opening a second tab gave that tab a new `top-app` process and moved the first one, with the worker in it, to `background`.
- **So ingest and compaction run on two small cores whenever the user is in another tab of the app.** The visible tab keeps all eight cores for its puts and gets.
- **The bench shows the same split.** During the write phases of `kv/overwrite`, one `background` process ran at 81 to 89% while the tab's `top-app` renderer ran at 0 to 63%.
- **Untested:** how much slower ingest and compaction are in that state, whether closing the first tab moves the worker, and other phones' cpusets.

## A locked phone runs the whole browser on two small cores

Behind the lock screen every Chromium process was in `background` (cpus 4-5, scheduling group 0, process state 12). Unlocked, the browser and the visible tab's renderer were in `top-app`.

| `bench run kv/ --size small`, wall time | Unlocked | Locked |
|---|---:|---:|
| `fillrandom` | 3.4 s | 8.3 s |
| `readrandom` | 2.5 s | 7.2 s |
| `readmissing` | 0.59 s | 2.1 s |
| `fillsync` | 2.2 s | 5.7 s |
| `ycsb-a` | 116 s | 307 s |
| `ycsb-f` | 177 s | 531 s |

- **Each column is one full run.** The `fillrandom` phase was also measured apart: 8.0 to 8.4 s over 8 locked runs, 3.4 to 3.6 s over 5 unlocked runs.
- **Pass and fail do not depend on the lock.** Every check in the tables above passed in both states.
- **The stand-in's own polling was ruled out.** It ran an adb command four times a second. Four alternating `fillrandom` runs took 8.0 and 8.0 s with it, 8.4 and 8.4 s without it.

### `ingest()` can outlast 20 s on a locked phone

The `quota` kind sets the origin's quota below its usage, asks one tab to ingest, restores the quota, and asks again while the other tabs keep writing.

| First ingest rejected with `StorageFullError` | Runs | Second ingest |
|---|---|---|
| Pixel 4a, locked | 7 | 2 answered, **5 timed out after 20 s** |
| Pixel 4a, unlocked | 6 | 6 answered |
| Desktop Chrome on the Mac | 1 | answered |

- **It is starvation, not a deadlock.** `navigator.locks.query()`, sampled every 0.7 s during two locked runs, never showed a pending request. The ingest and compaction locks were held and new L0 and L1 runs kept appearing, so the SharedWorker was ingesting the other tabs' writes the whole time.
- **The SharedWorker recovers.** Once the tabs stopped, a new tab's ingest answered in about 320 ms. No acked write was lost.
- **The lock state of the seven locked runs is inferred.** It was read after them, not during. Six of them have recovery opens of 348 to 603 ms, against 147 to 165 ms in the unlocked runs.
- **Open:** an explicit `ingest()` has no bound when the worker cannot keep up with the writers. A foreground user did not hit it in these runs.
- **Replay:** `kill-chrome --seed 11 --from 4 --iterations 1 --kinds page-crash,close-worker,kill-browser,browser-crash,quota --no-probes`.

## Timings on the unlocked phone

One run per phase at 100,000 entries, kv only, snapshot 1744109. An earlier run on snapshot 1744029 agreed within 3% on `fillrandom`, `ycsb-a` and `ycsb-f`. These show what each path costs on this phone. They are not a comparison with IndexedDB, and what bounds them was not profiled.

| Workload, phase | ops/s | p50 | p99 |
|---|---:|---:|---:|
| `fillrandom`, `putMany` of 1,000 | 29.8k | 12.5 ms | 56.3 ms |
| `fillrandom`, `readrandom` | 39.5k | 15 µs | 35 µs |
| `fillrandom`, `readmissing` | 170k | <10 µs | 10 µs |
| `fillseq`, `readseq` (range page) | 68.7k | 13.1 ms | 35.8 ms |
| `fillsync`, one `put` per ack | 477 | 1.89 ms | 3.52 ms |
| `ycsb-a` | 863 | 45 µs (read) | 2.37 ms (read) |
| `ycsb-c` | 34.0k | 15 µs | 45 µs |
| `ycsb-f` | 566 | 45 µs (read) | 1.95 ms (read) |

Cold open took 73 ms, and the first get after it 14 ms.

## What the harnesses cannot do on Android

- **`page-crash` reports a false failure.** After `Page.crash`, Chromium on Android sent only `Inspector.detached` with reason `Render process gone.` in 6 of 6 runs of [`crash-events.mjs`](android-device-run/crash-events.mjs), for a foreground and a background tab. `kill-chrome` waits for `Target.targetCrashed` or `Inspector.targetCrashed`, takes the dead tab for a survivor, and times out when it asks the tab to stop. One run of an earlier probe did see both crash events, with status `oom protected`. It was not reproduced.
- **`kill-renderer` finds nothing.** It looks for renderer processes in the process group of the Chrome it spawned, and those processes are on the phone.
- **`Browser.close` answers `Not implemented`.** The harness then waits about 20 s before it kills the browser, so an iteration takes 26 to 88 s.
- **One relaunch never answered.** A `browser-crash` iteration hung until the run was stopped. The same iteration passed in a replay. `android-chrome.mjs` then started to wait for the old browser process to exit and for the new one to answer on its devtools socket, and no later iteration hung. The cause was not confirmed.
- **A crashed renderer has a helper with the browser's process name.** Checking that the browser is alive by name stopped a healthy browser in 2 of 4 runs. `android-chrome.mjs` watches the pid.
- **Bench records are stamped with the Mac.** The host fields come from the machine that runs the CLI. `run.mjs` moves a device run's records out of `bench/results/`.
- **No process memory.** The largest-renderer column reads 0, because it is read from the local process table.

## Not tested

- Chrome stable, Firefox for Android, Samsung Internet, and Google's WebView.
- A second device, and a phone on battery.
- iOS Safari. The Mac had no Xcode, so no simulator.
- Power loss. A force-stop is a process kill.
