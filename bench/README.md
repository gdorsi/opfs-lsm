# Benchmarks

`pnpm bench` runs every workload on every contender of its family in real headless Chrome. Each run gets a fresh browser profile. Runs are interleaved: rep 1 of every contender, then rep 2, with the contender order rotated each rep. The defaults are size `small` and 5 reps.

```sh
pnpm bench                                   # everything, size small, 5 reps
pnpm bench kv/                               # one family
pnpm bench kv/fillrandom kv/ycsb-a --size large --reps 7
pnpm bench yjs/ --contenders kv              # one contender
pnpm bench:size                              # bundle sizes
pnpm bench:smoke                             # what CI runs: everything at size tiny, 1 rep
node bench/cli.ts compare results/a.jsonl results/b.jsonl
node bench/cli.ts report results/a.jsonl
```

Run `pnpm bench:smoke` first whenever the code under test changed. A full `pnpm bench` takes tens of minutes, and a broken path can run it into the 30-minute timeout; the smoke finds that in about a minute. Pass workload selectors as separate words, not one quoted variable: zsh does not split `$SEL`, so `pnpm bench $SEL` with `SEL="kv/ table/"` matches nothing.

Results go to `bench/results/<time>-<host>.jsonl` (one record per run) and a Markdown table next to it. They are not committed: numbers depend on the machine. To compare a change, run the same selection before and after on one machine and use `compare`. It calls a difference only when the min–max ranges of the two runs do not overlap.

Set `CHROME_PATH` when Chrome is not at the macOS default or on `PATH` as `google-chrome`.

## Families

| family | ours | baseline |
|---|---|---|
| `kv` | kv (`openDb`, SharedWorker host) | a hand-written IndexedDB key-value store: one object store, one transaction per batch, `getAll` pages for scans |
| `table` | collections | Dexie |
| `automerge` | the `examples/automerge-todo` kv storage adapter | automerge-repo's `IndexedDBStorageAdapter` |
| `yjs` | the `examples/yjs` `KvPersistence` | y-indexeddb |

`kv/kv-zig` is kv on the Zig engine module: the runner serves `crates/engine-zig/engine_small.wasm` for every `.wasm` request of that run (`driver/engines.ts`), because the tab and the SharedWorker host each load the engine and only the server sees both.

Every contender uses its library's fast path, and the report prints that path and the durability next to the numbers. kv's WAL commits with IndexedDB's default durability (relaxed in Chrome since version 121), so the IndexedDB baselines use the default too.

## Workloads

The kv workloads follow RocksDB's db_bench and YCSB. Keys are 16 bytes and values 100 bytes, half compressible (LevelDB's setup). Sizes are `tiny` 1,000 entries, `small` 100,000 and `large` 1,000,000.

- `kv/fillrandom`: random fill, random reads before and after compaction settles, reads of missing keys, then a cold open.
- `kv/fillseq`: ascending fill, a full scan, random seeks of 10 and 100 keys.
- `kv/fillsync`: N/100 single puts, each awaited.
- `kv/overwrite`: random fill, then N random overwrites.
- `kv/deleterandom`: random fill, delete 10%, space before and after compaction.
- `kv/ycsb-a` … `kv/ycsb-f`: YCSB core workloads A to F, as in YCSB's workload files. Pebble uses the same letters for different mixes.
- `table/todos`: the operations of RxDB's storage comparison on a todo table with two indexes: first insert, bulk and serial inserts, gets by id, index queries, updates, deletes, cold open.
- `automerge/trace`, `yjs/trace`: the LaTeX editing trace (about 260k keystrokes; 2,000 at `tiny`, 26,000 at `small`) through the persistence layer, then a cold load. The trace downloads once into `bench/.data/`.
- `automerge/many-docs`, `yjs/many-docs`: many small notes written, then each loaded cold.

"Cold" means a new tab opened after every SharedWorker has exited: a cold page over warm OS storage. A page cannot drop the OS cache.

Every read is checked against the expected value. One wrong value fails the run, and a failed run never feeds a number.

## Amplification

kv counts the bytes it writes in the configuration apps run: the tab and the SharedWorker host. The counters come from `readStats` in `@opfs-lsm/kv/testing`. The report derives:

- **W-Amp engine**: (flush + compaction bytes written) / user bytes in. This is the number RocksDB and Pebble report.
- **W-Amp total**: (WAL + flush + compaction + manifest bytes) / user bytes in. It counts the WAL, as Lim et al. (FAST '16) do. WAL bytes are the records handed to IndexedDB; what IndexedDB itself writes is not visible.
- **Compaction**: compaction bytes / flush bytes.
- **Read-Amp**: L0 runs + non-empty deeper levels. After open, kv reads are in memory, so there is no per-read disk count.
- **Space-Amp**: OPFS bytes / live key and value bytes. It can go below 1 once data reaches L2, which is LZ4-compressed.

IndexedDB baselines only have `navigator.storage.estimate()`, which is approximate. Those cells are marked `~`. For the CRDT families, user bytes are the bytes the CRDT asked storage to save, and live bytes are the encoded document size.

The definitions and sources are in [docs/research/benchmark-prior-art.md](../docs/research/benchmark-prior-art.md).

## Bundle size

`pnpm bench:size` measures what Vite emits for each row in `size/rows.ts`: the import an app writes. "At import" is the entry chunk and its static imports. "After open" adds every file those load later: the SharedWorker chunk, its imports and the `.wasm`. Each file is compressed on its own (gzip -9, brotli 11). `--check` fails when a row is over its brotli budget, and CI runs it. The build also fails if any module is inlined as a `data:` URL, which is how Vite broke kv's SharedWorker before its URL was written inline in the constructor.

## Adding a workload or contender

A workload is one file in `workloads/<family>/`. A contender is one file in `contenders/<family>/`. Every workload runs on every contender of its family. The page finds both with `import.meta.glob`, so nothing else lists them. Each family's interface is in `core/families.ts`. A workload calls only that interface, so every contender does the same operations.

A workload is a list of phases run in order on one database (`page: "fresh"` starts a new tab). A phase body only does the ops. `ctx.time` times one call, `ctx.model` holds the expected values, `ctx.rng` is seeded the same for every contender.

## Layout

```
cli.ts            run | smoke | size | compare | report
core/             types, family interfaces, histogram
driver/           Vite build, static server, Chrome over CDP, plan, run loop, report, size
page/             the bench page: phase executor, data model, kv and IndexedDB helpers
size/rows.ts      bundle-size rows and budgets
contenders/       one file per contender, by family
workloads/        one file per workload, by family; kv-lib.ts and trace.ts are shared helpers
```
