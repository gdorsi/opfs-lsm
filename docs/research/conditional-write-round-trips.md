# Round trips in a conditional write

Date: 2026-11-11. Chrome 157 headless, macOS arm64, Apple M5 Max. Commit `5b26f17` plus local
probes. The machine ran other work during every measurement, so absolute times are high. Each
comparison below alternates its variants call by call inside one run, which cancels that noise.

Status: the explicit commit is implemented. The one-round-trip write is not.

## Question

`update` (and so every docstore `put`) costs more than a write in the IndexedDB libraries it is
compared with. Where does the time go, and what can be removed without changing what `update`
promises?

## Where the time goes

Timing each stage of a docstore `put` in `table/todos` showed 97% of it inside the one WAL
transaction: p50 495 to 880 µs right after the bulk load, 330 to 390 µs in the later `update`
phase. Reading the keys the body needs and applying the record to the memtable took 5 to 20 µs
together.

That transaction makes three sequential trips between the tab and the browser process:

1. read the tail (three gets on `meta`, a reverse key cursor on `wal`);
2. add the record;
3. commit, which the browser starts only after the add's success event has reached the tab.

## The reverse key cursor is not the cost

A Chrome trace showed the cursor at about 82 µs per write in the browser process against about
7 µs per get, so it looked like the thing to remove. It is not. Three ways of reading the head,
alternated call by call (16,600 calls each, `kv/ycsb-f`):

| head read | p50 of the tail read | mean |
|---|---:|---:|
| reverse key cursor | 100 µs | 163 µs |
| `getAllKeys({ direction: "prev", count: 1 })` | 95 µs | 155 µs |
| `getAllKeys` above the seq the tab has applied | 95 µs | 140 µs |

Two more runs gave the same picture. The 82 µs is the transaction's first trip, which whichever
request goes first pays.

## Explicit commit

Calling `commit()` on the transaction right after the add removes trip 3. Alternated call by
call with the previous code:

| run | pairs | p50 before | p50 after | p90 before | p90 after |
|---|---:|---:|---:|---:|---:|
| `kv/ycsb-f` | 24,985 | 200 µs | 160 µs | 285 µs | 235 µs |
| `kv/ycsb-f` | 25,125 | 280 µs | 235 µs | 6965 µs | 6905 µs |
| `kv/ycsb-f` | 24,921 | 315 µs | 270 µs | 555 µs | 485 µs |
| `table/todos` | 581 | 195 µs | 155 µs | 525 µs | 510 µs |
| `table/todos` | 581 | 330 µs | 290 µs | 2135 µs | 1705 µs |
| `table/todos` | 581 | 355 µs | 320 µs | 940 µs | 755 µs |

About 40 µs per write, at every percentile, in every run. A request that fails after `commit()`
still aborts the transaction, so the ack means what it meant before.

## One-round-trip write (not implemented)

Trip 1 can be folded into trip 2: run the body against the memtable as it is, add the record
under the key IndexedDB assigns, and abort when the assigned key or the `meta` values show that
something landed in between. Alternated call by call in `table/todos` (about 580 pairs a run):

| run | p50 before | p50 one trip |
|---|---:|---:|
| 1 | 365 µs | 255 µs |
| 2 | 415 µs | 255 µs |
| 3 | 290 µs | 195 µs |

It was not taken because it changes what `update` promises. When the guess is wrong the body
runs a second time, which happened in 6 to 8 of about 580 writes (inferred: when the host
ingested).
`kv/ycsb-f` failed its read checks under the prototype for that reason: its body advances the
bench model. Shipping this means documenting that a body must be free of side effects.

## Not measured

- Plain `put` and `batch`. Their append checks the assigned key in the add's success handler,
  so it cannot call `commit()` before that handler runs.
- Firefox and Safari.
- A quiet machine. The docstore `serial-insert` loss against Dexie (0.40× in the clean run of
  issue 139) is about 170 µs per write, so this change narrows it and does not close it.
