# A profile pass over the kv and docstore hot paths

Status: rejected. No code changed. Three memtable variants were measured and rejected, and the
memtable stays as design.md, "Memtable" describes it. The `sync` write tail at 200,000 issues was
taken up in [compaction-file-waits.md](compaction-file-waits.md).

Date: 2026-11-24. Chrome 157 headless, macOS arm64, Apple M2 Pro, commit `f8854bdd`. Other
sessions ran headless Chromium on the machine during every measurement, with a load average of
10 to 30 on 10 cores. Identical runs of one build took 3.5 s to 9 s, so this note compares
shares inside one run and never wall times between runs. No Chrome A/B was run.

## Question

After four rounds of hot-path work, is there a change left in kv or docstore that makes a
workload measurably faster and fits the bundle budgets?

## Where the time goes

`bench/probes/cpu-profile.ts` recorded ten phases at size `small`: `replay`, `recent`,
`drainedPage` and `triagePage` of `tracker/goals` on docstore, `fillrandom`, `readrandom` and
`fillsync` of `kv/fillrandom`, `ycsb-a` of `kv/ycsb-a`, and `coldopen` of `tanstack/todos` on kv.

One function stands out. The memtable insert, a binary search over a chunk's rows and a splice,
is the largest kv cost in the tab on every write path:

| phase | tab busy | memtable insert | the rest of kv and docstore |
|---|---:|---:|---|
| `tracker/goals` `replay` | 2,467 ms | about 300 ms | no function above 2% |
| `kv/fillrandom` `fillrandom` | 259 ms | about 62 ms | under 10 ms each |
| `kv/ycsb-a` `ycsb-a` | 2,182 ms | 92 ms | native IndexedDB calls lead: `transaction` 314 ms, `add` 173 ms |

The same insert runs when a fresh tab replays the WAL tail, so it also shows in the cold round of
each goal after `recent`.

The other phases are flat:

- `readrandom` spends more in the bench's own key and value checks than in kv. `get`, the block
  seek and the block index search take 20 to 30 ms each of 370 ms.
- `fillsync`, one awaited put at a time, is idle for 334 ms of 341 ms. It waits for the
  IndexedDB commit, as the baseline does.
- The cold load of 91,000 rows through TanStack DB spends about 70 ms in TanStack DB, 15 ms in
  docstore's JSON parse and about 20 ms in kv's scan, and is idle for 105 ms while OPFS reads.
- The garbage collector is among the top three entries of every write profile, 57 ms of 259 ms
  in `fillrandom`. Keys and values are already copied into pools, so what is left is one op
  object and one memtable row per write.

## The memtable insert

A node harness replayed the tracker history through docstore on the memory fs with
`fake-indexeddb`, with counters in the memtable. The replay of 85,928 events does 549,515
inserts and about 155,000 point reads of the memtable. That is 6.4 inserts an event, which is
what the tracker schema asks for: a document, eight indexes, one of them multi-entry and one a
text index, and most index keys hold `updatedAt`, so a patch rewrites them. Docstore writes no
entry that did not change.

A search makes 9.5 probes and compares 56 bytes in all, 6 bytes a probe, so the shared-prefix
skip works and the byte loop is not the cost. That skip shipped before this pass, in `fb5b6093`
(2026-11-20), and is in every measurement here. In Chrome a search takes about 0.4 µs, 33 ns a
probe. A probe reads the row object and then its key, two objects that sit apart in memory.

Three variants, each measured as its share of one profiled node replay:

| variant | result | verdict |
|---|---|---|
| A `keys` array beside each chunk's rows, so a search reads no row object, and one search function for the chunk lookup and the row lookup | search fell from about 9.2% to about 7.1% of the replay over 4 interleaved runs, near 2% of the write path | rejected: 135 gzip bytes at import |
| 32 or 128 rows a chunk instead of 512 | within the noise: the probes saved in the chunk move to the search over the chunks' first keys | rejected |
| A delete row with the same shape as a put row | within the noise | rejected |

A standalone microbench of the first variant with 16-byte random keys showed 18% to 28% less
time, and none with docstore-shaped keys of 44 bytes. The real workload sits between the two.

Two designs were not built:

- **A lazy memtable** that sorts rows on the first read. A docstore write reads the stored rows
  first, and an app's lists query after every write, so the sort only moves to the next read.
  It helps a pure write burst, which is the benchmark and not an app.
- **A 4-byte tag per row** in a number array, taken after the chunk's common prefix, so a search
  touches one hot array. It could cut the search several times over, at about 60 lines and
  several hundred bytes, for 5% to 10% of bulk random writes. It is a cache of key bytes.

## Bundle size

At `f8854bdd`, kv's import budget was 19,900 gzip bytes and the main-thread chunk had almost no
room under it. `bench/size/rows.ts` holds the current budget.
`node bench/cli.ts size --check` passes on Node 24, which CI uses, and reports
`kv at import 19934 > 19900 gzip` on Node 26.13.1 for the same tree: the two versions gzip the
same file to different sizes. Measure with Node 24, after a build of the packages, since the
size build reads each package's `dist`.

## Write tail latency at 200,000 issues

The committed run `docs/results/2026-11-23T22-22-35-apple-m5-max.md` shows the docstore `replay`
at size `large` with a `sync` batch at p50 2.02 ms, p99 5.76 ms, p99.9 868 ms and a maximum of
1,040 ms, and an `import` batch at p99.9 704 ms. Dexie's slowest `sync` batch in that run took
108 ms. About 9 of 8,729 batches wait near a second.

The likely cause is the memtable's hard cap: a write waits for a flush, and the flush waits for
a compaction step once L0 holds its limit of runs.
[compaction-file-waits.md](compaction-file-waits.md) confirmed it. At size `small` the
slowest `sync` batch takes 29 ms, and the slow `import` batches are the ones that hold issues,
which write 14 entries a row where a comment writes 2.

This is the largest gap this pass found, and it is in the flush and compaction design, not in a
hot loop. It needs runs at size `large` on a quiet machine.

## Choices

**The memtable stays as it is.** Its insert is the only hot spot left, and the one variant that
helped is worth about 2% of a write for 135 bytes the budget does not have.

**No table of `docs/benchmarks.md` changed.** No code changed, and the machine was too busy for
a run that could be published.

**The next work on write speed starts from the tail**, not from the profile: find what holds a
`sync` batch for a second at 200,000 issues.
