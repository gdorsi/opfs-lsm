# Reserve

How the host keeps the reserve file, what it does when the browser refuses a write, and how a tab
frees space when asked. What the reserve promises is in [design.md](design.md#reserve).

The host holds the largest `reserveBytes` any open tab passed, until the last tab closes the
database. With 0 it keeps no file and makes no offer. Nothing about the reserve is stored but the
file: its size on disk is the truth across hosts and restarts.

**File.** `opfs-lsm/<name>/reserve` holds `reserveBytes` zero bytes. The bytes are written, not
left by a truncate: a sparse file holds quota and no disk blocks, and a full disk refuses a write
as a full quota does. The host writes the file inside the exclusive section of a flush, so a fill
and a flush never overlap. `openDb` does not write it, and `destroyDb` removes it with the folder.
A fill that a crash cut off can leave `reserve.crswap`, which the host removes when it next looks
at the file.

**Settle.** A compaction pass that finds nothing left to plan settles over its manifest. A pass
runs after each flush, and every 2 s while the reserve is not held. A pass that stops at its step
limit settles nothing: under heavy writes the reserve waits for a pass that finishes.

**States.** The host holds one of four states for each database. A pair with no row changes
nothing.

| State | Event | Next | The host |
|---|---|---|---|
| unknown | a settle, with `reserveBytes` 0 | held 0 | removes the file |
| unknown | a settle | held | reads the file's size, and writes the file when it differs from `reserveBytes` |
| unknown | a refused write | offered | removes the file and posts the offer; the write runs again |
| held `b` | a settle, with `b` under `reserveBytes` | held | writes the file |
| held `b` over 0 | a refused write | offered | removes the file and posts the offer; the write runs again |
| held 0 | a refused write, or a fill the browser refuses | offered | posts the offer |
| held | a tab opens the database | unknown | |
| offered | `full-pull` | offered | posts the offer again |
| offered | `full-done` | answered at the WAL head `s` | flushes now if the head moved since the offer |
| answered at `s` | a settle over a manifest whose `through` is at least `s` | held | writes the file; if the browser refuses, offered, and it posts the offer |
| any | the last tab closes the database | unknown | |

A fill the browser refuses leaves the file as it was, so a held file that is too small stays. An
offered database gets no fill and no second offer: the handlers still need the room. An answer
counts only once a flush holds what the handlers wrote. Handlers that wrote nothing start no
flush, so the host asks them again at most once per settle, and never because of their own
answer. A new host starts at unknown.

**Refused write.** A write of a flush or a compaction that fails with `QuotaExceededError` runs
once more when that failure removed the file. Any other refused write fails with
`StorageFullError`: the acked writes stay in the WAL, and the host flushes again after another
1 MiB of writes or the next `openDb`.

**Refused append.** A WAL group that aborts with `QuotaExceededError` sends `make-room` to the
host, which handles it as a refused write, then opens a new IndexedDB connection and adds the
same records once more. Groups refused together share one `make-room` and keep the order they
were issued in, and `update` runs its `body` again. A second refusal fails every write of the
group with `StorageFullError`, whose `cause` is the browser's error. The connection is replaced
after every such abort, and no write transaction starts while it is: a connection that saw one
can refuse every later write.

**Offer.** The host posts `{ kind: "full", full: { bytes, need } }` on the layers channel: `bytes`
is the sum of the run file bytes of the recorded manifest, and `need` is `reserveBytes`. The
three messages are posted once each: if the channel loses one, offers stop until another handle
takes the lock or the last tab closes the database.

**Answer.** A handle with an `onStorageFull` handler asks for the Web Lock `opfs-lsm-full/<name>`
and keeps it while it has one. On the grant it posts `full-pull`, for an offer posted while
another handle held the lock. Only the holder answers: it calls its handlers in turn, then posts
`full-done`, whether they resolved or threw. A holder that closes mid-answer, or whose tab goes
away, posts nothing, and the next holder pulls the offer. A handle with no handler asks for the
lock shared with `ifAvailable` on each offer. Granted, no handle has a handler: it warns once and
posts `full-done`, so the file comes back when space frees elsewhere.
