# Run the Chrome proofs on an Android device

Tools that point the repo's Chrome harnesses at a browser on a phone, over adb. Findings: [`docs/research/android-device-run.md`](../android-device-run.md).

You need a device with USB debugging on, `adb` on your `PATH` (or `ANDROID_ADB` set to it), and a browser on the device that answers on a devtools socket. Build first with `pnpm --filter './packages/*' build`.

## Run everything

```sh
node docs/research/android-device-run/run.mjs --install-chromium
```

`run.mjs` picks the attached device (set `ANDROID_SERIAL` when there are several), installs the latest Chromium snapshot when the browser is missing, keeps the screen on, runs each step below with a time limit, and prints one line per step. It writes each step's log, the bench records and `summary.json` to `results/<time>/`, which is gitignored. At the end it restores the screen setting, removes the flags file and the adb tunnels, and uninstalls a browser it installed. It exits 0 when every step passed.

| Option | Use |
|---|---|
| `--install-chromium` | Download the Chromium snapshot for Android arm64 (about 440 MB, cached under `results/`) and install it when `org.chromium.chrome` is missing. |
| `--chromium-revision N` | Install snapshot `N`, not the latest. |
| `--keep-browser` | Leave the installed browser on the device. |
| `--only a,b`, `--skip a,b` | Pick steps: `probe`, `two-tab`, `two-tab-nobc`, `two-tab-no-flags`, `two-tab-local`, `bench-smoke`, `bench-kv`, `kill`. |
| `--out DIR` | Write the logs to `DIR`. |

A locked phone gives valid pass and fail results, and slow timings: behind the lock screen Android confines the browser to its background CPU set. Unlock the phone before a run whose timings you will read. `run.mjs` prints which state it found and records it as `locked` in `summary.json`.

## Run one harness

```sh
export ANDROID_SERIAL=<serial from adb devices>
export CHROME_PATH=$PWD/docs/research/android-device-run/android-chrome.mjs

node docs/research/android-device-run/probe.mjs                      # which APIs the browser has, then openDb, put, get
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab     # also two-tab-nobc, two-tab-local
ANDROID_CLEAR=1 node bench/cli.ts smoke                              # every workload at 1,000 entries
ANDROID_CLEAR=1 node bench/cli.ts run kv/ --size small --reps 1 --contenders kv
pnpm --filter @opfs-lsm/kv exec tsx scripts/kill-chrome.ts --kinds close-worker,kill-browser,browser-crash,quota
node docs/research/android-device-run/crash-events.mjs               # CDP events after Page.crash
node docs/research/android-device-run/worker-cpuset.mjs              # which CPU set a SharedWorker's process is in
```

`android-chrome.mjs` is a stand-in for the Chrome binary. A harness spawns it with Chrome's arguments. It starts the browser on the device, forwards the device's devtools socket to the port the harness expects, and reverses the harness's HTTP ports to the device. The options are in the comment at the top of the file.

| Variable | Default | Use |
|---|---|---|
| `ANDROID_BROWSER` | `org.chromium.chrome` | The package to launch. A package without `chrom` in its name is treated as a WebView app. |
| `ANDROID_CLEAR` | unset | `1` wipes the browser's data before each launch. Set it for `bench`, which expects a fresh profile per run. Leave it unset for `kill-chrome`, which relaunches on the same profile. Never set it for a browser whose data you want to keep. |
| `ANDROID_FLAGS` | `harness` | `none` drops the harness's anti-throttling flags, so a background tab is treated as it is for a user. |

Limits:

- Chrome reads `/data/local/tmp/chrome-command-line` only on a `userdebug` or `eng` system image, or when the package is the debug app (`adb shell am set-debug-app --persistent <package>`). The run in the findings used a `userdebug` image. Without the file, a fresh install stops at the first-run screen.
- Leave `page-crash` and `kill-renderer` out of `kill-chrome --kinds`. The findings say why.
- `bench` writes its records to `bench/results/` with the host fields of the machine that runs the CLI. Move a device run's files out, or `bench compare` reads them as runs on that machine.
- The device browser stays installed, and its `chrome-command-line` file stays on the device, until you remove them.
