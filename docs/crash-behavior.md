# Crash behavior

What each crash leaves behind, step by step. The invariant and the rule that make every
case open are in [design.md](design.md#recovery).

Each step writes new files before anything points at them, and deletes files only after nothing
points at them.

A **process crash** keeps every completed write of both stores. Every acked write survives.

| Crash after | State on reopen |
|---|---|
| Append, before `complete` | The batch is not in the WAL. The caller got no ack. |
| L0 run written, before its manifest | The run is garbage. The records are in the WAL. |
| Manifest written, before the IndexedDB commit | The manifest is ignored. The records are in the WAL, and the next flush folds them again. |
| IndexedDB commit, before reclaim | Old manifests and runs stay until a later pass removes them. |
| Compaction outputs written, before install | The outputs are garbage. |
| Destroy's transaction, before its removes finish | The database is empty. The files left are garbage. |

The first sweep of a new host removes every run that the recorded manifest does not list.

A **power loss** keeps a prefix of the commits of IndexedDB and a prefix of the file operations
of OPFS, independently.

| IndexedDB kept | OPFS kept | Reopen |
|---|---|---|
| The commit of a flush | Not its run or manifest | Rule 3. The previous manifest is intact, and the WAL still holds the seqs that flush folded. Nothing is lost. If OPFS lost more than one flush, the WAL is dropped. |
| Not the commit of a compaction | Its manifest and its removals | Rule 3. The new manifest is intact and has the same `through`. Nothing is lost. |
| Some appends, not the flush after them | The manifest of that flush | Rule 1. `head` moves to its `through`. |
| Nothing | Some manifests | Rule 3 records the newest intact one, and `head` moves past its seqs. |
| A destroy's transaction | Any prefix of its removes and of later ops | No manifest from before the destroy is adopted. The database holds a prefix of the writes after it, or none. |
| Not a destroy's transaction | None of its removes | The commit was not on disk, so no remove had started. As if the destroy had not run. |
