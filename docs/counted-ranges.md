# Counted ranges

How `count` and `offset` answer without walking the entries they count or skip. The reads
themselves are in [design.md](design.md#reads).

## What a write says

A put or a delete may say whether its key held a value before it: `was`, absent or present. With
it the write states what it does to the number of live keys:

| Write | Was absent | Was present |
|---|---|---|
| put | plus one | nothing |
| delete | nothing | minus one |

A write that does not say is unknown. Only `update` takes `was`, because only a write that read
its key in the same transaction knows. A write of a key the `update` read is given its `was` by
kv. A write of a key the `update` did not read, such as an entry derived from a row it read,
passes `was` itself, and kv does not check it. `batch` refuses `was`.

## Where it is kept

* A WAL op holds its `was` in its type byte ([design.md](design.md#wal-records)).
* A run record holds it in its tag. A block's index entry counts the plus, minus and unknown
  records of the block, its tally ([sst-format.md](sst-format.md#index-entry)).
* A manifest holds the tally of each run ([manifest-format.md](manifest-format.md)).

## The fold

A memtable row, a flushed record and a merged record each stand for several writes of one key:
the newest gives the value, and the oldest gives `was`. So the record states what the whole
stretch does to the number of live keys.

* **Memtable.** A write over a row the memtable holds was preceded by that row, so its `was`
  follows from the row, whatever the writer said. The row keeps the `was` of its oldest write.
  It also keeps the seq and `was` of each later write, until a flush folds the oldest ones into
  a run: the row then says what held before the oldest write left.
* **Flush.** A run takes each row as a memtable that holds exactly the flushed records has it.
* **Merge.** A step reads the versions of a key newest first. The winner takes the `was` of the
  oldest version that no mark covers. In a bottom step nothing older is left, so every put it
  writes was absent, and deletes are dropped. This is what gives blind writes a `was`.
* **Range deletes.** A version a mark covers is no part of the stretch. A version the mark
  spares, written before the mark's record at a seq past its `through`, may have seen a version
  the mark covers: if it says present, the memtable and a merge make it unknown.

**Invariant.** Take the memtable and the runs of one generation. If every version of a key says
`was`, and no mark holds the key, its versions say plus once more than minus when the key is live
and as often when it is not.

## Counting

A count of a range adds the tallies of every source: the memtable rows in the range, and for
each level the runs wholly inside from the manifest, the blocks wholly inside from the index of
the run at each end, and the records inside of the block each bound cuts. It reads at most two
blocks of each level. The count is plus less minus.

A count scans instead, with the merge of `range`, when the sum could be wrong:

* a record in the range is unknown, or
* a mark meets the range: a version it covers is still counted by the run that holds it, or
* `valueContains` is given.

## Offset

A scan with a large `offset` starts past most of what it skips. Going forward:

1. Take the level whose tallies in the range are largest. Its candidate keys are where its runs
   begin, then where the blocks of one run begin.
2. For a candidate, bound from above the live keys between the start of the range and the
   candidate, with no block read: whole runs and blocks exactly, and a block the candidate cuts
   by its plus count. An unknown record makes the candidate unusable.
3. Take the furthest candidate whose bound is at most the offset, by binary search.
4. Count the live keys before it exactly, start the scan there, and take that count off the
   offset.
5. Repeat from the new start while a step moves it. The scan walks what is left of the offset.

Going back is the same from the end of the range. An offset under 256 is walked. A scan whose
skipped part cannot be counted walks all of it.
